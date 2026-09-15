import http from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || join(__dirname, "data", "core-slices.json");
const port = Number(process.env.PORT || 3025);
const testHooksEnabled = process.env.ALLOW_TEST_HOOKS !== "0";
const statuses = ["待切割", "制片中", "待观察", "已交付"];
const taskSteps = ["取样", "切割", "研磨", "染色", "观察"];
const reviewStatuses = ["待占位", "盲评中", "待仲裁", "仲裁中", "已定稿", "待处理"];
const defaultClaimTtlMinutes = 30;

const seed = {
  samples: [
    {
      id: "CORE-001",
      project: "东岭铜矿薄片",
      borehole: "ZK-17",
      coreBox: "BX-09",
      depth: "128.4-128.8m",
      owner: "陆川",
      status: "制片中",
      delivery: "未交付",
      slices: [
        { id: "SL-001-A", method: "茜素红染色", observation: "", status: "研磨", logs: [{ at: "2026-06-12T10:00:00.000Z", step: "取样", note: "截取含矿化条带位置" }, { at: "2026-06-13T11:20:00.000Z", step: "切割", note: "完成粗切" }] }
      ]
    }
  ],
  standards: [
    { version: "v1", categories: ["砂岩", "灰岩", "花岗岩", "矿化蚀变岩"], tolerance: 5, note: "初始鉴定标准", createdAt: "2026-06-01T00:00:00.000Z" }
  ],
  reviews: []
};

const nowIso = () => new Date().toISOString();

// 原子写入：先写临时文件再改名，任何失败都不会留下写了一半的库文件。
async function saveDb(db, req) {
  if (testHooksEnabled && req && req.headers["x-test-fail-save"] === "1") throw new Error("simulated_save_failure");
  const tmp = dbPath + ".tmp";
  await writeFile(tmp, JSON.stringify(db, null, 2));
  await rename(tmp, dbPath);
}

// 互斥锁：所有写操作串行化，并发抢名额/重复提交只会有一个生效。
let lockChain = Promise.resolve();
function withLock(task) {
  const result = lockChain.then(() => task());
  lockChain = result.catch(() => {});
  return result;
}

function emptySlot(slot) { return { slot, reviewer: null, claimedAt: null, claimExpiresAt: null, vote: null, submittedAt: null }; }
function currentStandard(db) { return db.standards[db.standards.length - 1]; }

function ensureReview(db, sample, slice) {
  if (db.reviews.some(r => r.sampleId === sample.id && r.sliceId === slice.id)) return false;
  const std = currentStandard(db);
  db.reviews.push({
    id: `RV-${slice.id}`,
    sampleId: sample.id,
    sliceId: slice.id,
    standardVersion: std.version,
    categories: std.categories.slice(),
    tolerance: std.tolerance,
    slots: [emptySlot(1), emptySlot(2)],
    arbitration: null,
    conflicts: [],
    reassignments: [],
    status: "待占位",
    final: null,
    createdAt: nowIso()
  });
  return true;
}

function migrate(db) {
  let changed = false;
  if (!Array.isArray(db.standards) || !db.standards.length) {
    db.standards = seed.standards.map(s => ({ ...s, categories: s.categories.slice() }));
    changed = true;
  }
  if (!Array.isArray(db.reviews)) { db.reviews = []; changed = true; }
  for (const sample of db.samples || []) {
    for (const slice of sample.slices || []) {
      if (slice.status === "观察" && ensureReview(db, sample, slice)) changed = true;
    }
  }
  return changed;
}

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await saveDb(seed);
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  if (migrate(db)) await saveDb(db);
  return db;
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function updateSampleStatus(sample) {
  const sliceStatuses = sample.slices.map(slice => slice.status);
  if (sliceStatuses.length && sliceStatuses.every(step => step === "观察")) sample.status = "待观察";
  if (sample.delivery === "已交付") sample.status = "已交付";
  else if (sliceStatuses.some(step => ["取样", "切割", "研磨", "染色"].includes(step))) sample.status = "制片中";
  else sample.status = "待切割";
}

// ---------- 盲评与仲裁 ----------
function slotExpired(s) { return !!(s && s.reviewer && !s.vote && s.claimExpiresAt && s.claimExpiresAt <= nowIso()); }
function arbExpired(a) { return !!(a && a.arbitrator && !a.vote && a.claimExpiresAt && a.claimExpiresAt <= nowIso()); }

function parseRatios(ratios) {
  if (!ratios || typeof ratios !== "object" || Array.isArray(ratios)) return { error: "ratios_must_be_object" };
  const keys = Object.keys(ratios).map(k => k.trim()).filter(Boolean);
  if (!keys.length || keys.length > 12) return { error: "ratios_components_invalid" };
  let sum = 0;
  const out = {};
  for (const k of keys) {
    const v = Number(ratios[k]);
    if (!Number.isFinite(v) || v < 0 || v > 100) return { error: "ratio_out_of_range" };
    out[k] = v;
    sum += v;
  }
  if (Math.abs(sum - 100) > 0.5) return { error: "ratios_must_sum_100" };
  return { ratios: out };
}

function compareVotes(tolerance, a, b) {
  if (a.category !== b.category) return { align: false, reason: "类别不一致", exceeded: [] };
  const keys = [...new Set([...Object.keys(a.ratios), ...Object.keys(b.ratios)])];
  const exceeded = [];
  for (const k of keys) {
    const av = a.ratios[k] || 0;
    const bv = b.ratios[k] || 0;
    const diff = Math.round(Math.abs(av - bv) * 10) / 10;
    if (diff > tolerance) exceeded.push({ component: k, a: av, b: bv, diff });
  }
  return exceeded.length ? { align: false, reason: "比例超差", exceeded } : { align: true };
}
function mergeRatios(a, b) {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  return Object.fromEntries(keys.map(k => [k, Math.round(((a[k] || 0) + (b[k] || 0)) / 2 * 10) / 10]));
}

function evaluateReview(review) {
  const [s1, s2] = review.slots;
  const cmp = compareVotes(review.tolerance, s1.vote, s2.vote);
  if (cmp.align) {
    review.final = {
      category: s1.vote.category,
      ratios: mergeRatios(s1.vote.ratios, s2.vote.ratios),
      source: "盲评一致",
      standardVersion: review.standardVersion,
      finalizedAt: nowIso()
    };
    review.status = "已定稿";
  } else {
    review.conflicts.push({ at: nowIso(), reason: cmp.reason, categories: [s1.vote.category, s2.vote.category], exceeded: cmp.exceeded });
    review.arbitration = { arbitrator: null, claimedAt: null, claimExpiresAt: null, vote: null, submittedAt: null };
    review.status = "待仲裁";
  }
}

function recomputeStatus(review) {
  if (review.final) { review.status = "已定稿"; return; }
  if (review.status === "待处理") return;
  const voted = review.slots.filter(s => s.vote).length;
  if (voted === 2) {
    review.status = review.arbitration && review.arbitration.arbitrator ? "仲裁中" : "待仲裁";
    return;
  }
  review.status = review.slots.some(s => s.reviewer) ? "盲评中" : "待占位";
}

// 盲评脱敏：双方提交前，占位人身份与票内容互不可见。
function publicReview(review, sample) {
  const slice = sample ? sample.slices.find(s => s.id === review.sliceId) : null;
  const bothVoted = review.slots.every(s => s.vote);
  const slots = review.slots.map(s => {
    const out = { slot: s.slot, occupied: !!s.reviewer, submitted: !!s.vote };
    if (s.reviewer && !s.vote) out.claimExpiresAt = s.claimExpiresAt;
    if (bothVoted && s.reviewer) { out.reviewer = s.reviewer; out.vote = s.vote; out.submittedAt = s.submittedAt; }
    return out;
  });
  let arbitration = null;
  if (review.arbitration) {
    arbitration = { occupied: !!review.arbitration.arbitrator, submitted: !!review.arbitration.vote };
    if (review.arbitration.arbitrator) arbitration.arbitrator = review.arbitration.arbitrator;
    if (review.arbitration.arbitrator && !review.arbitration.vote) arbitration.claimExpiresAt = review.arbitration.claimExpiresAt;
    if (review.arbitration.vote) { arbitration.vote = review.arbitration.vote; arbitration.submittedAt = review.arbitration.submittedAt; }
  }
  return {
    id: review.id,
    sampleId: review.sampleId,
    sliceId: review.sliceId,
    project: sample ? sample.project : "",
    method: slice ? slice.method : "",
    standardVersion: review.standardVersion,
    categories: review.categories,
    tolerance: review.tolerance,
    status: review.status,
    slots,
    arbitration,
    conflicts: review.conflicts,
    reassignments: review.reassignments,
    final: review.final,
    createdAt: review.createdAt
  };
}

const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>岩芯样本切片实验室</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#242822; --muted:#687062; --line:#d7ddd1; --accent:#526f43; --stone:#73706a; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; gap:16px; }
    h1 { margin:0; font-size:26px; } main { display:grid; grid-template-columns:390px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; } h2 { margin:0 0 12px; font-size:18px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; }
    .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(310px,1fr)); gap:12px; } .card { display:grid; gap:8px; align-content:start; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .slice { border-top:1px solid var(--line); padding-top:10px; } .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; }
    .board { display:grid; grid-template-columns:340px 1fr; gap:22px; padding:0 28px 28px; }
    .rstats { grid-template-columns:repeat(6,1fr); } .strip { margin-bottom:12px; } .msg { color:#b3261e; font-size:13px; min-height:18px; margin-top:6px; }
    .final { border:1px solid var(--accent); background:#f3f7ef; border-radius:6px; padding:8px; }
    .conflict { border-left:3px solid #c9a227; padding-left:8px; } .arb { border:1px dashed var(--stone); border-radius:6px; padding:8px; display:grid; gap:6px; }
    .row { display:flex; gap:8px; } .row select { width:auto; }
    @media (max-width:950px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} .stats{grid-template-columns:1fr 1fr;} .board{grid-template-columns:1fr;padding:0 16px 16px;} .rstats{grid-template-columns:1fr 1fr;} }
  </style>
</head>
<body>
  <header><div><h1>岩芯样本切片实验室</h1><div class="meta">样本、切片任务、制片步骤、交付与观察结论盲评仲裁</div></div><button id="reload">刷新</button></header>
  <main>
    <form id="form">
      <h2>创建岩芯样本</h2>
      <label>项目</label><input name="project" required>
      <label>钻孔编号</label><input name="borehole" required>
      <label>岩芯箱号</label><input name="coreBox" required>
      <label>取样深度</label><input name="depth" required>
      <label>负责人</label><input name="owner" required>
      <label>初始切片编号</label><input name="sliceId" required>
      <label>染色方法</label><input name="method" required>
      <button>保存样本</button>
    </form>
    <section>
      <div class="stats" id="stats"></div>
      <div class="grid" id="samples"></div>
    </section>
  </main>
  <section class="board">
    <div class="panel">
      <h2>鉴定标准</h2>
      <div id="stdCurrent" class="meta"></div>
      <label>类别（逗号分隔）</label><input id="stdCats" placeholder="砂岩,灰岩,花岗岩">
      <label>比例容差 ±%</label><input id="stdTol" type="number" min="0" max="100" step="0.5">
      <label>备注</label><input id="stdNote" placeholder="版本说明">
      <button id="publishStd">发布新标准版本</button>
      <div class="meta">新标准只影响之后建立的盲评；进行中的盲评沿用原快照，已定稿结果不回改。</div>
    </div>
    <div class="panel">
      <h2>盲评与仲裁台</h2>
      <div class="meta">每张完成观察的切片有两个独立鉴定槽位，提交前双方互不可见；类别不一致或比例超差交第三人仲裁，三人仍不一致则保持待处理。</div>
      <label>当前鉴定员 / 仲裁员</label><input id="me" placeholder="姓名，占位和提交时使用">
      <div id="msg" class="msg"></div>
      <div class="stats rstats" id="reviewStats"></div>
      <div class="meta strip" id="todoStrip"></div>
      <div class="grid" id="reviews"></div>
    </div>
  </section>
  <script>
    const statuses = ${JSON.stringify(statuses)};
    const steps = ${JSON.stringify(taskSteps)};
    const reviewStatuses = ${JSON.stringify(reviewStatuses)};
    const form = document.querySelector("#form");
    const stats = document.querySelector("#stats");
    const samplesEl = document.querySelector("#samples");
    const reviewStatsEl = document.querySelector("#reviewStats");
    const reviewsEl = document.querySelector("#reviews");
    const todoEl = document.querySelector("#todoStrip");
    let samples = [], reviews = [], standards = [];
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ "Content-Type":"application/json" } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "请求失败");
      return data;
    }
    function showMsg(t) { document.querySelector("#msg").textContent = t || ""; }
    async function guard(fn) { try { showMsg(""); await fn(); } catch (e) { showMsg("失败：" + e.message); } }
    function me() {
      const v = document.querySelector("#me").value.trim();
      if (!v) throw new Error("请先填写当前鉴定员/仲裁员姓名");
      return v;
    }
    function fmtRatios(r) { return Object.keys(r || {}).map(k => k + ":" + r[k] + "%").join("  "); }
    function parseRatiosText(text) {
      const out = {};
      String(text || "").split(/[,，;；]/).map(s => s.trim()).filter(Boolean).forEach(pair => {
        const idx = pair.search(/[:：]/);
        if (idx > 0) out[pair.slice(0, idx).trim()] = Number(pair.slice(idx + 1));
      });
      return out;
    }
    function render() {
      stats.innerHTML = statuses.map(s => '<div class="stat"><span>'+s+'</span><strong>'+samples.filter(item => item.status === s).length+'</strong></div>').join("");
      samplesEl.innerHTML = samples.map(sample => '<article class="card"><h3>'+sample.project+'</h3><span class="pill">'+sample.status+'</span><div class="meta">'+sample.borehole+' · '+sample.coreBox+' · '+sample.depth+' · '+sample.owner+'</div><label>新增切片</label><input data-new-slice="'+sample.id+'" placeholder="切片编号"><input data-method="'+sample.id+'" placeholder="染色方法"><button data-add="'+sample.id+'">添加切片</button>'+sample.slices.map(slice => { const rev = reviews.find(x => x.sampleId === sample.id && x.sliceId === slice.id); return '<div class="slice"><b>'+slice.id+'</b> '+(rev ? '<span class="pill">盲评：'+rev.status+'</span>' : '')+'<div class="meta">'+slice.method+' · 当前步骤 '+slice.status+'</div><select data-step="'+sample.id+'|'+slice.id+'">'+steps.map(step => '<option>'+step+'</option>').join("")+'</select><textarea data-note="'+sample.id+'|'+slice.id+'" placeholder="步骤备注或观察结果"></textarea><button data-log="'+sample.id+'|'+slice.id+'">记录步骤</button><div class="meta">'+slice.logs.map(log => log.step+"："+log.note).join(" / ")+'</div></div>'; }).join("")+'<button data-deliver="'+sample.id+'">标记交付</button></article>').join("");
      document.querySelectorAll("[data-step]").forEach(sel => {
        const [sampleId, sliceId] = sel.dataset.step.split("|");
        const slice = samples.find(s => s.id === sampleId).slices.find(s => s.id === sliceId);
        sel.value = slice.status;
      });
      document.querySelectorAll("[data-add]").forEach(btn => btn.onclick = async () => {
        const id = btn.dataset.add;
        await api('/api/samples/'+id+'/slices', { method:'POST', body: JSON.stringify({ id: document.querySelector('[data-new-slice="'+id+'"]').value, method: document.querySelector('[data-method="'+id+'"]').value || "未指定" }) });
        await load();
      });
      document.querySelectorAll("[data-log]").forEach(btn => btn.onclick = async () => {
        const [sampleId, sliceId] = btn.dataset.log.split("|");
        await api('/api/samples/'+sampleId+'/slices/'+sliceId+'/logs', { method:'POST', body: JSON.stringify({ step: document.querySelector('[data-step="'+sampleId+'|'+sliceId+'"]').value, note: document.querySelector('[data-note="'+sampleId+'|'+sliceId+'"]').value || "步骤完成" }) });
        await load();
      });
      document.querySelectorAll("[data-deliver]").forEach(btn => btn.onclick = async () => { await api('/api/samples/'+btn.dataset.deliver+'/deliver', { method:'POST', body: JSON.stringify({}) }); await load(); });
    }
    function slotLine(s) {
      if (!s.occupied) return "空";
      if (!s.reviewer) return s.submitted ? "已提交（内容保密）" : "已占位（身份保密，截止 " + (s.claimExpiresAt || "").slice(11, 19) + "）";
      let t = s.reviewer + (s.submitted ? " · 已提交" : " · 待提交");
      if (s.vote) t += " · " + s.vote.category + " · " + fmtRatios(s.vote.ratios);
      return t;
    }
    function conflictLine(c) {
      let t = c.at.slice(0, 16).replace("T", " ") + " · " + c.reason;
      if (c.exceeded && c.exceeded.length) t += "：" + c.exceeded.map(e => e.component + " " + e.a + "% vs " + e.b + "%（差" + e.diff + "）").join("，");
      else if (c.categories && c.categories.length) t += "：" + c.categories.join(" vs ");
      return t;
    }
    function reviewCard(r) {
      let html = '<article class="card"><h3>' + r.id + ' · ' + r.sliceId + '</h3>'
        + '<div><span class="pill">' + r.status + '</span> <span class="pill">标准 ' + r.standardVersion + ' · 容差±' + r.tolerance + '%</span></div>'
        + '<div class="meta">' + r.project + ' · ' + r.method + '</div>'
        + '<div class="meta">槽位1：' + slotLine(r.slots[0]) + '<br>槽位2：' + slotLine(r.slots[1]) + '</div>';
      if (r.status === "待占位" || r.status === "盲评中") {
        html += '<div class="row"><select data-slot="' + r.id + '"><option value="1">槽位1</option><option value="2">槽位2</option></select><button data-claim="' + r.id + '">占位</button></div>'
          + '<label>类别</label><select data-cat="' + r.id + '">' + r.categories.map(c => '<option>' + c + '</option>').join("") + '</select>'
          + '<label>定量比例（合计100，如 石英:40,长石:35,云母:25）</label><input data-ratios="' + r.id + '" placeholder="石英:40,长石:35,云母:25">'
          + '<button data-vote="' + r.id + '">提交盲评</button>';
      }
      if (r.conflicts.length) html += '<div class="conflict"><b>冲突项</b>' + r.conflicts.map(c => '<div class="meta">' + conflictLine(c) + '</div>').join("") + '</div>';
      if (r.status === "待仲裁" || r.status === "仲裁中") {
        html += '<div class="arb"><b>仲裁（需第三人）</b><div class="meta">' + (r.arbitration && r.arbitration.occupied ? '仲裁员：' + (r.arbitration.arbitrator || "保密") + (r.arbitration.submitted ? ' · 已提交' : ' · 待提交') : '等待仲裁员占位') + '</div>';
        if (r.status === "待仲裁") html += '<button data-arbclaim="' + r.id + '">仲裁占位</button>';
        if (r.status === "仲裁中") html += '<label>仲裁类别</label><select data-arbcat="' + r.id + '">' + r.categories.map(c => '<option>' + c + '</option>').join("") + '</select><label>仲裁比例</label><input data-arbratios="' + r.id + '" placeholder="石英:40,长石:35,云母:25"><button data-arbvote="' + r.id + '">提交仲裁</button>';
        html += '</div>';
      }
      if (r.final) html += '<div class="final"><b>最终结论</b><div>' + r.final.category + ' · ' + fmtRatios(r.final.ratios) + '</div><div class="meta">来源：' + r.final.source + ' · 标准 ' + r.final.standardVersion + ' · ' + r.final.finalizedAt.slice(0, 10) + '</div></div>';
      if (r.status === "待处理") html += '<div class="meta">三人仍未一致，保持待处理。</div>';
      if (r.reassignments.length) html += '<div class="meta">重派记录：' + r.reassignments.map(x => x.slot + ' ' + x.from + '→' + (x.to || '空缺')).join('；') + '</div>';
      html += '<button data-reassign="' + r.id + '">重派超时名额</button></article>';
      return html;
    }
    function renderBoard() {
      const std = standards[standards.length - 1];
      document.querySelector("#stdCurrent").innerHTML = std ? '当前版本 <b>' + std.version + '</b> · 容差 ±' + std.tolerance + '% · 类别：' + std.categories.join('、') + (std.note ? ' · ' + std.note : '') : '暂无标准';
      reviewStatsEl.innerHTML = reviewStatuses.map(s => '<div class="stat"><span>' + s + '</span><strong>' + reviews.filter(r => r.status === s).length + '</strong></div>').join("");
      const arb = reviews.filter(r => r.status === "待仲裁" || r.status === "仲裁中");
      const conf = reviews.filter(r => r.conflicts && r.conflicts.length);
      todoEl.innerHTML = '<b>待仲裁项：</b>' + (arb.length ? arb.map(r => r.id + '（' + r.status + '）').join('、') : '无') + ' &nbsp;·&nbsp; <b>冲突项：</b>' + (conf.length ? conf.map(r => r.id).join('、') : '无');
      reviewsEl.innerHTML = reviews.length ? reviews.map(reviewCard).join("") : '<div class="meta">切片完成“观察”步骤后自动建立盲评。</div>';
      document.querySelectorAll("[data-claim]").forEach(btn => btn.onclick = () => guard(async () => {
        const id = btn.dataset.claim;
        await api('/api/reviews/' + id + '/claim', { method: 'POST', body: JSON.stringify({ reviewer: me(), slot: Number(document.querySelector('[data-slot="' + id + '"]').value) }) });
        await load();
      }));
      document.querySelectorAll("[data-vote]").forEach(btn => btn.onclick = () => guard(async () => {
        const id = btn.dataset.vote;
        await api('/api/reviews/' + id + '/votes', { method: 'POST', body: JSON.stringify({ reviewer: me(), category: document.querySelector('[data-cat="' + id + '"]').value, ratios: parseRatiosText(document.querySelector('[data-ratios="' + id + '"]').value) }) });
        await load();
      }));
      document.querySelectorAll("[data-arbclaim]").forEach(btn => btn.onclick = () => guard(async () => {
        await api('/api/reviews/' + btn.dataset.arbclaim + '/arbitration/claim', { method: 'POST', body: JSON.stringify({ arbitrator: me() }) });
        await load();
      }));
      document.querySelectorAll("[data-arbvote]").forEach(btn => btn.onclick = () => guard(async () => {
        const id = btn.dataset.arbvote;
        await api('/api/reviews/' + id + '/arbitration/vote', { method: 'POST', body: JSON.stringify({ arbitrator: me(), category: document.querySelector('[data-arbcat="' + id + '"]').value, ratios: parseRatiosText(document.querySelector('[data-arbratios="' + id + '"]').value) }) });
        await load();
      }));
      document.querySelectorAll("[data-reassign]").forEach(btn => btn.onclick = () => guard(async () => {
        await api('/api/reviews/' + btn.dataset.reassign + '/reassign', { method: 'POST', body: JSON.stringify({}) });
        await load();
      }));
    }
    async function load(){
      const results = await Promise.all([api("/api/samples"), api("/api/reviews"), api("/api/standards")]);
      samples = results[0]; reviews = results[1]; standards = results[2];
      render(); renderBoard();
    }
    document.querySelector("#reload").onclick = load;
    document.querySelector("#publishStd").onclick = () => guard(async () => {
      await api("/api/standards", { method: "POST", body: JSON.stringify({ categories: document.querySelector("#stdCats").value, tolerance: Number(document.querySelector("#stdTol").value), note: document.querySelector("#stdNote").value }) });
      await load();
    });
    form.onsubmit = async event => {
      event.preventDefault();
      await api("/api/samples", { method:"POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
      form.reset(); await load();
    };
    load();
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type":"text/html; charset=utf-8" });
      return res.end(page);
    }
    if (req.method === "GET" && url.pathname === "/api/samples") return sendJson(res, 200, (await loadDb()).samples);
    if (req.method === "GET" && url.pathname === "/api/standards") return sendJson(res, 200, (await loadDb()).standards);
    if (req.method === "GET" && url.pathname === "/api/reviews") {
      const db = await loadDb();
      return sendJson(res, 200, db.reviews.map(r => publicReview(r, db.samples.find(s => s.id === r.sampleId))));
    }
    if (req.method === "POST" && url.pathname === "/api/samples") {
      return await withLock(async () => {
        const db = await loadDb();
        const input = await body(req);
        const sample = { id: `CORE-${Date.now()}`, project: input.project, borehole: input.borehole, coreBox: input.coreBox, depth: input.depth, owner: input.owner, status: "待切割", delivery: "未交付", slices: [{ id: input.sliceId, method: input.method, observation: "", status: "取样", logs: [{ at: new Date().toISOString(), step: "取样", note: "创建初始切片任务" }] }] };
        updateSampleStatus(sample);
        db.samples.unshift(sample);
        await saveDb(db, req);
        return sendJson(res, 201, sample);
      });
    }
    if (req.method === "POST" && url.pathname === "/api/standards") {
      return await withLock(async () => {
        const db = await loadDb();
        const input = await body(req);
        const cats = Array.isArray(input.categories) ? input.categories : String(input.categories || "").split(/[,，]/);
        const categories = cats.map(c => String(c).trim()).filter(Boolean);
        const tolerance = Number(input.tolerance);
        if (!categories.length) return sendJson(res, 400, { error: "categories_required" });
        if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 100) return sendJson(res, 400, { error: "tolerance_invalid" });
        const std = { version: "v" + (db.standards.length + 1), categories, tolerance, note: String(input.note || ""), createdAt: nowIso() };
        db.standards.push(std);
        await saveDb(db, req);
        return sendJson(res, 201, std);
      });
    }
    const claimMatch = url.pathname.match(/^\/api\/reviews\/([^/]+)\/claim$/);
    if (claimMatch && req.method === "POST") {
      return await withLock(async () => {
        const db = await loadDb();
        const review = db.reviews.find(r => r.id === claimMatch[1]);
        if (!review) return sendJson(res, 404, { error: "review_not_found" });
        const input = await body(req);
        const reviewer = String(input.reviewer || "").trim();
        const slotNo = Number(input.slot);
        if (!reviewer) return sendJson(res, 400, { error: "reviewer_required" });
        if (![1, 2].includes(slotNo)) return sendJson(res, 400, { error: "slot_invalid" });
        if (!["待占位", "盲评中"].includes(review.status)) return sendJson(res, 409, { error: "review_not_open_for_claim" });
        const target = review.slots[slotNo - 1];
        const other = review.slots[2 - slotNo];
        if (other.reviewer === reviewer) {
          if (slotExpired(other)) {
            review.reassignments.push({ at: nowIso(), slot: "槽位" + other.slot, from: other.reviewer, to: null, reason: "超时释放" });
            Object.assign(other, emptySlot(other.slot));
          } else {
            return sendJson(res, 409, { error: "reviewer_duplicate" });
          }
        }
        if (target.reviewer) {
          if (target.reviewer === reviewer && !target.vote && !slotExpired(target)) {
            return sendJson(res, 200, publicReview(review, db.samples.find(s => s.id === review.sampleId)));
          }
          if (target.vote) return sendJson(res, 409, { error: "slot_closed" });
          if (!slotExpired(target)) return sendJson(res, 409, { error: "slot_taken" });
          review.reassignments.push({ at: nowIso(), slot: "槽位" + target.slot, from: target.reviewer, to: reviewer, reason: "超时重派" });
        }
        const ttl = Number.isFinite(Number(input.ttlMinutes)) ? Number(input.ttlMinutes) : defaultClaimTtlMinutes;
        Object.assign(target, { reviewer, claimedAt: nowIso(), claimExpiresAt: new Date(Date.now() + ttl * 60000).toISOString(), vote: null, submittedAt: null });
        review.status = "盲评中";
        await saveDb(db, req);
        return sendJson(res, 200, publicReview(review, db.samples.find(s => s.id === review.sampleId)));
      });
    }
    const voteMatch = url.pathname.match(/^\/api\/reviews\/([^/]+)\/votes$/);
    if (voteMatch && req.method === "POST") {
      return await withLock(async () => {
        const db = await loadDb();
        const review = db.reviews.find(r => r.id === voteMatch[1]);
        if (!review) return sendJson(res, 404, { error: "review_not_found" });
        const input = await body(req);
        const reviewer = String(input.reviewer || "").trim();
        if (review.final || review.status === "待处理") return sendJson(res, 409, { error: "review_closed" });
        const slot = review.slots.find(s => s.reviewer === reviewer);
        if (!slot) return sendJson(res, 409, { error: "no_claim" });
        if (slot.vote) return sendJson(res, 409, { error: "already_submitted" });
        if (slotExpired(slot)) return sendJson(res, 409, { error: "claim_expired" });
        if (!review.categories.includes(input.category)) return sendJson(res, 400, { error: "unknown_category" });
        const parsed = parseRatios(input.ratios);
        if (parsed.error) return sendJson(res, 400, { error: parsed.error });
        slot.vote = { category: input.category, ratios: parsed.ratios };
        slot.submittedAt = nowIso();
        if (review.slots.every(s => s.vote)) evaluateReview(review);
        await saveDb(db, req);
        return sendJson(res, 200, publicReview(review, db.samples.find(s => s.id === review.sampleId)));
      });
    }
    const arbClaimMatch = url.pathname.match(/^\/api\/reviews\/([^/]+)\/arbitration\/claim$/);
    if (arbClaimMatch && req.method === "POST") {
      return await withLock(async () => {
        const db = await loadDb();
        const review = db.reviews.find(r => r.id === arbClaimMatch[1]);
        if (!review) return sendJson(res, 404, { error: "review_not_found" });
        if (!review.arbitration || !["待仲裁", "仲裁中"].includes(review.status)) return sendJson(res, 409, { error: "not_in_arbitration" });
        const input = await body(req);
        const arbitrator = String(input.arbitrator || "").trim();
        if (!arbitrator) return sendJson(res, 400, { error: "arbitrator_required" });
        if (review.slots.some(s => s.reviewer === arbitrator)) return sendJson(res, 409, { error: "arbitrator_must_be_third" });
        const arb = review.arbitration;
        if (arb.arbitrator) {
          if (arb.arbitrator === arbitrator && !arb.vote && !arbExpired(arb)) {
            return sendJson(res, 200, publicReview(review, db.samples.find(s => s.id === review.sampleId)));
          }
          if (arb.vote) return sendJson(res, 409, { error: "arbitration_closed" });
          if (!arbExpired(arb)) return sendJson(res, 409, { error: "arbitration_taken" });
          review.reassignments.push({ at: nowIso(), slot: "仲裁", from: arb.arbitrator, to: arbitrator, reason: "超时重派" });
        }
        const ttl = Number.isFinite(Number(input.ttlMinutes)) ? Number(input.ttlMinutes) : defaultClaimTtlMinutes;
        Object.assign(arb, { arbitrator, claimedAt: nowIso(), claimExpiresAt: new Date(Date.now() + ttl * 60000).toISOString(), vote: null, submittedAt: null });
        review.status = "仲裁中";
        await saveDb(db, req);
        return sendJson(res, 200, publicReview(review, db.samples.find(s => s.id === review.sampleId)));
      });
    }
    const arbVoteMatch = url.pathname.match(/^\/api\/reviews\/([^/]+)\/arbitration\/vote$/);
    if (arbVoteMatch && req.method === "POST") {
      return await withLock(async () => {
        const db = await loadDb();
        const review = db.reviews.find(r => r.id === arbVoteMatch[1]);
        if (!review) return sendJson(res, 404, { error: "review_not_found" });
        if (review.status !== "仲裁中" || !review.arbitration) return sendJson(res, 409, { error: "not_in_arbitration" });
        const input = await body(req);
        const arbitrator = String(input.arbitrator || "").trim();
        const arb = review.arbitration;
        if (arb.arbitrator !== arbitrator) return sendJson(res, 409, { error: "no_claim" });
        if (arb.vote) return sendJson(res, 409, { error: "already_submitted" });
        if (arbExpired(arb)) return sendJson(res, 409, { error: "claim_expired" });
        if (!review.categories.includes(input.category)) return sendJson(res, 400, { error: "unknown_category" });
        const parsed = parseRatios(input.ratios);
        if (parsed.error) return sendJson(res, 400, { error: parsed.error });
        arb.vote = { category: input.category, ratios: parsed.ratios };
        arb.submittedAt = nowIso();
        const [s1, s2] = review.slots;
        const c1 = compareVotes(review.tolerance, arb.vote, s1.vote);
        const c2 = compareVotes(review.tolerance, arb.vote, s2.vote);
        if (c1.align || c2.align) {
          const agreed = c1.align ? s1 : s2;
          review.final = {
            category: arb.vote.category,
            ratios: mergeRatios(arb.vote.ratios, agreed.vote.ratios),
            source: "仲裁定稿（与" + agreed.reviewer + "一致）",
            standardVersion: review.standardVersion,
            finalizedAt: nowIso()
          };
          review.status = "已定稿";
        } else {
          review.conflicts.push({ at: nowIso(), reason: "仲裁仍未一致，保持待处理", categories: [s1.vote.category, s2.vote.category, arb.vote.category], exceeded: [] });
          review.status = "待处理";
        }
        await saveDb(db, req);
        return sendJson(res, 200, publicReview(review, db.samples.find(s => s.id === review.sampleId)));
      });
    }
    const reassignMatch = url.pathname.match(/^\/api\/reviews\/([^/]+)\/reassign$/);
    if (reassignMatch && req.method === "POST") {
      return await withLock(async () => {
        const db = await loadDb();
        const review = db.reviews.find(r => r.id === reassignMatch[1]);
        if (!review) return sendJson(res, 404, { error: "review_not_found" });
        const freed = [];
        for (const slot of review.slots) {
          if (slotExpired(slot)) {
            freed.push({ slot: slot.slot, from: slot.reviewer });
            review.reassignments.push({ at: nowIso(), slot: "槽位" + slot.slot, from: slot.reviewer, to: null, reason: "超时释放" });
            Object.assign(slot, emptySlot(slot.slot));
          }
        }
        if (review.arbitration && arbExpired(review.arbitration)) {
          freed.push({ slot: "仲裁", from: review.arbitration.arbitrator });
          review.reassignments.push({ at: nowIso(), slot: "仲裁", from: review.arbitration.arbitrator, to: null, reason: "超时释放" });
          Object.assign(review.arbitration, { arbitrator: null, claimedAt: null, claimExpiresAt: null, vote: null, submittedAt: null });
        }
        recomputeStatus(review);
        await saveDb(db, req);
        return sendJson(res, 200, { freed, review: publicReview(review, db.samples.find(s => s.id === review.sampleId)) });
      });
    }
    const addSlice = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices$/);
    if (addSlice && req.method === "POST") {
      return await withLock(async () => {
        const db = await loadDb();
        const sample = db.samples.find(item => item.id === addSlice[1]);
        if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
        const input = await body(req);
        sample.slices.push({ id: input.id, method: input.method || "未指定", observation: "", status: "取样", logs: [{ at: new Date().toISOString(), step: "取样", note: "新增切片任务" }] });
        updateSampleStatus(sample);
        await saveDb(db, req);
        return sendJson(res, 201, sample);
      });
    }
    const logMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/logs$/);
    if (logMatch && req.method === "POST") {
      return await withLock(async () => {
        const db = await loadDb();
        const sample = db.samples.find(item => item.id === logMatch[1]);
        if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
        const slice = sample.slices.find(item => item.id === logMatch[2]);
        if (!slice) return sendJson(res, 404, { error: "slice_not_found" });
        const input = await body(req);
        slice.status = input.step;
        if (input.step === "观察") {
          slice.observation = input.note || slice.observation;
          ensureReview(db, sample, slice);
        }
        slice.logs.push({ at: new Date().toISOString(), step: input.step, note: input.note || "" });
        updateSampleStatus(sample);
        await saveDb(db, req);
        return sendJson(res, 200, sample);
      });
    }
    const deliverMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/deliver$/);
    if (deliverMatch && req.method === "POST") {
      return await withLock(async () => {
        const db = await loadDb();
        const sample = db.samples.find(item => item.id === deliverMatch[1]);
        if (!sample) return sendJson(res, 404, { error: "sample_not_found" });
        sample.delivery = "已交付";
        updateSampleStatus(sample);
        await saveDb(db, req);
        return sendJson(res, 200, sample);
      });
    }
    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(port, () => console.log(`Core slice lab app listening on http://localhost:${port}`));
