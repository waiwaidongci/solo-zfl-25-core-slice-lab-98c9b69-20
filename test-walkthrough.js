import { spawn } from "node:child_process";
import { readdir, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3199;
const DB_PATH = join(__dirname, "data", "test-walkthrough.json");
const base = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? "PASS" : "FAIL") + " | " + name + (cond ? "" : " | " + JSON.stringify(extra)));
  if (!cond) failures++;
}
async function api(path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { "Content-Type": "application/json", ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}
// 首屏请求：服务未监听时重试，HTTP 错误不重试（要验证的就是状态码）
async function getFirstScreen(path) {
  for (let i = 0; i < 200; i++) {
    try {
      const res = await fetch(base + path);
      return { status: res.status, data: await res.json().catch(() => null) };
    } catch {
      await sleep(50);
    }
  }
  throw new Error("server not reachable: " + path);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

let child;
async function waitPort() {
  for (let i = 0; i < 200; i++) {
    const ok = await new Promise(resolve => {
      const sock = net.connect(PORT, "127.0.0.1");
      sock.once("connect", () => { sock.end(); resolve(true); });
      sock.once("error", () => resolve(false));
    });
    if (ok) return;
    await sleep(50);
  }
  throw new Error("server did not start");
}
async function startServer(extraEnv = {}) {
  child = spawn(process.execPath, [join(__dirname, "server.js")], {
    env: { ...process.env, PORT: String(PORT), DB_PATH, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stderr.on("data", d => process.stderr.write("[server] " + d));
  await waitPort();
}
async function stopServer() {
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise(r => child.once("exit", r));
  }
}
async function reviewOf(sliceId) {
  const { data } = await api("/api/reviews");
  return data.find(r => r.sliceId === sliceId);
}
async function sampleOf(id) {
  const { data } = await api("/api/samples");
  return data.find(s => s.id === id);
}
async function tmpFiles() {
  return (await readdir(dirname(DB_PATH))).filter(f => f.endsWith(".tmp"));
}
const claim = (rv, reviewer, slot, ttlMinutes) => api(`/api/reviews/${rv}/claim`, { method: "POST", body: { reviewer, slot, ttlMinutes } });
const vote = (rv, reviewer, category, ratios, headers) => api(`/api/reviews/${rv}/votes`, { method: "POST", body: { reviewer, category, ratios }, headers });

async function main() {
  await rm(DB_PATH, { force: true });
  for (const f of await tmpFiles().catch(() => [])) await rm(join(dirname(DB_PATH), f), { force: true });

  // ========== 阶段0：旧格式数据 + 并发首屏 + 迁移只发生一次 + 状态边界 ==========
  // 旧格式库（无 standards/reviews 字段），且批次状态是历史错误值
  const legacy = {
    samples: [
      { id: "CORE-A", project: "老批次A", borehole: "ZK-A", coreBox: "BX-A", depth: "1-2m", owner: "前人", status: "待切割", delivery: "未交付",
        slices: [
          { id: "SL-A1", method: "薄片", observation: "已完成", status: "观察", logs: [] },
          { id: "SL-A2", method: "薄片", observation: "已完成", status: "观察", logs: [] }
        ] },
      { id: "CORE-B", project: "老批次B", borehole: "ZK-B", coreBox: "BX-B", depth: "3-4m", owner: "前人", status: "待切割", delivery: "未交付",
        slices: [{ id: "SL-B1", method: "薄片", observation: "", status: "研磨", logs: [] }] }
    ]
  };
  await writeFile(DB_PATH, JSON.stringify(legacy, null, 2));
  await startServer({ ALLOW_TEST_HOOKS: "1" });

  // 同时到达的首屏请求（页面 + 三个接口 × 3 批）必须全部成功
  const firstScreen = await Promise.all([
    getFirstScreen("/"), getFirstScreen("/api/samples"), getFirstScreen("/api/standards"), getFirstScreen("/api/reviews"),
    getFirstScreen("/"), getFirstScreen("/api/samples"), getFirstScreen("/api/standards"), getFirstScreen("/api/reviews"),
    getFirstScreen("/"), getFirstScreen("/api/samples"), getFirstScreen("/api/standards"), getFirstScreen("/api/reviews")
  ]);
  check("并发首屏请求全部成功", firstScreen.every(r => r.status === 200), firstScreen.map(r => r.status));

  let r = await api("/api/reviews");
  check("迁移为观察切片建盲评且仅一次（无重复）", r.data.length === 2 && new Set(r.data.map(x => x.id)).size === 2, r.data.map(x => x.id));
  r = await api("/api/standards");
  check("迁移补标准且仅一个版本", r.data.length === 1 && r.data[0].version === "v1", r.data);
  check("全部切片观察的批次状态修正为待观察", (await sampleOf("CORE-A")).status === "待观察", await sampleOf("CORE-A"));
  check("制片中的批次状态修正", (await sampleOf("CORE-B")).status === "制片中", await sampleOf("CORE-B"));
  check("初始化不留临时文件", (await tmpFiles()).length === 0, await tmpFiles());

  const m1 = (await stat(DB_PATH)).mtimeMs;
  await sleep(150);
  await api("/api/samples"); await api("/api/reviews"); await api("/api/standards");
  const m2 = (await stat(DB_PATH)).mtimeMs;
  check("迁移只发生一次（后续 GET 不重写库文件）", m1 === m2, { m1, m2 });

  // ========== 页面与旧入口 ==========
  const html = await (await fetch(base + "/")).text();
  check("页面包含盲评状态/待仲裁/冲突/最终结论区块", html.includes("盲评与仲裁台") && html.includes("待仲裁项") && html.includes("冲突项") && html.includes("最终结论"));
  check("旧入口保留（创建样本表单）", html.includes("创建岩芯样本") && html.includes("标记交付"));

  // ========== 建样本与切片，走到观察 ==========
  const sample = (await api("/api/samples", { method: "POST", body: { project: "盲评走查", borehole: "ZK-T", coreBox: "BX-T", depth: "1-2m", owner: "测试", sliceId: "SL-T1", method: "薄片" } })).data;
  const sid = sample.id;
  check("新样本初始状态为制片中", sample.status === "制片中", sample.status);
  for (const id of ["SL-T2", "SL-T3", "SL-T4", "SL-T5", "SL-T6", "SL-T7"]) {
    await api(`/api/samples/${sid}/slices`, { method: "POST", body: { id, method: "薄片" } });
  }
  for (const id of ["SL-T1", "SL-T2", "SL-T3", "SL-T4", "SL-T5", "SL-T6"]) {
    await api(`/api/samples/${sid}/slices/${id}/logs`, { method: "POST", body: { step: "观察", note: "镜下观察完成" } });
  }
  check("部分切片观察时批次仍制片中", (await sampleOf(sid)).status === "制片中", (await sampleOf(sid)).status);

  // ========== 场景1：盲评一致 ==========
  let rv = await reviewOf("SL-T1");
  check("观察完成后自动建立盲评（两个槽位·待占位）", rv && rv.status === "待占位" && rv.slots.length === 2, rv);
  check("新盲评快照当前标准 v1", rv.standardVersion === "v1" && rv.tolerance === 5, rv);
  await claim("RV-SL-T1", "甲", 1);
  await claim("RV-SL-T1", "乙", 2);
  rv = await reviewOf("SL-T1");
  check("提交前双方互不可见（身份与票内容脱敏）", rv.slots[0].occupied && rv.slots[0].reviewer === undefined && rv.slots[0].vote === undefined, rv.slots);
  r = await vote("RV-SL-T1", "甲", "砂岩", { 石英: 40, 长石: 35, 云母: 25 });
  check("甲提交盲评", r.status === 200, r);
  rv = await reviewOf("SL-T1");
  check("一方提交后内容仍保密", rv.slots[0].submitted && rv.slots[0].vote === undefined, rv.slots);
  r = await vote("RV-SL-T1", "乙", "砂岩", { 石英: 43, 长石: 34, 云母: 23 });
  check("容差内一致 → 已定稿（盲评一致）", r.data && r.data.status === "已定稿" && r.data.final.source === "盲评一致", r.data);
  check("定稿比例取两者均值", r.data.final.ratios["石英"] === 41.5 && r.data.final.ratios["云母"] === 24, r.data.final);
  rv = await reviewOf("SL-T1");
  check("双方提交后公开身份与票数", rv.slots[0].reviewer === "甲" && rv.slots[1].vote.category === "砂岩", rv.slots);

  // ========== 场景2：类别不一致 → 第三人仲裁 ==========
  await claim("RV-SL-T2", "甲", 1);
  await claim("RV-SL-T2", "乙", 2);
  await vote("RV-SL-T2", "甲", "砂岩", { 石英: 40, 长石: 35, 云母: 25 });
  r = await vote("RV-SL-T2", "乙", "灰岩", { 方解石: 60, 石英: 25, 云母: 15 });
  check("类别不一致 → 待仲裁并记录冲突", r.data.status === "待仲裁" && r.data.conflicts[0].reason === "类别不一致", r.data);
  r = await api("/api/reviews/RV-SL-T2/arbitration/claim", { method: "POST", body: { arbitrator: "甲" } });
  check("原鉴定员不能仲裁（需第三人）", r.status === 409 && r.data.error === "arbitrator_must_be_third", r);
  r = await api("/api/reviews/RV-SL-T2/arbitration/claim", { method: "POST", body: { arbitrator: "丙" } });
  check("第三人仲裁占位 → 仲裁中", r.status === 200 && r.data.status === "仲裁中", r.data);
  r = await api("/api/reviews/RV-SL-T2/arbitration/vote", { method: "POST", body: { arbitrator: "丙", category: "砂岩", ratios: { 石英: 41, 长石: 34, 云母: 25 } } });
  check("仲裁与甲一致 → 已定稿（仲裁定稿）", r.data.status === "已定稿" && r.data.final.source.includes("仲裁"), r.data);

  // ========== 场景3：比例超差 → 三人不一致保持待处理 ==========
  await claim("RV-SL-T3", "甲", 1);
  await claim("RV-SL-T3", "乙", 2);
  await vote("RV-SL-T3", "甲", "砂岩", { 石英: 40, 长石: 35, 云母: 25 });
  r = await vote("RV-SL-T3", "乙", "砂岩", { 石英: 60, 长石: 20, 云母: 20 });
  check("比例超差 → 待仲裁并记录超差明细", r.data.status === "待仲裁" && r.data.conflicts[0].reason === "比例超差" && r.data.conflicts[0].exceeded.some(e => e.component === "石英" && e.diff === 20), r.data);
  await api("/api/reviews/RV-SL-T3/arbitration/claim", { method: "POST", body: { arbitrator: "丙" } });
  r = await api("/api/reviews/RV-SL-T3/arbitration/vote", { method: "POST", body: { arbitrator: "丙", category: "灰岩", ratios: { 方解石: 70, 石英: 30 } } });
  check("三人仍不一致 → 保持待处理、无最终结论", r.data.status === "待处理" && !r.data.final, r.data);
  check("待处理记录第二条冲突", r.data.conflicts.length === 2, r.data.conflicts);

  // ========== 场景4：超时名额重派 ==========
  await claim("RV-SL-T4", "甲", 1, -1); // 已过期
  r = await claim("RV-SL-T4", "乙", 1);
  rv = await reviewOf("SL-T4");
  check("超时名额可被他人重派（抢占）", r.status === 200 && rv.reassignments.some(x => x.from === "甲" && x.to === "乙" && x.reason === "超时重派"), rv.reassignments);
  await claim("RV-SL-T4", "甲", 2, -1); // 甲的名额已被重派，可占槽位2，但立即过期
  r = await vote("RV-SL-T4", "甲", "砂岩", { 石英: 40, 长石: 35, 云母: 25 });
  check("过期名额提交被拒", r.status === 409 && r.data.error === "claim_expired", r);
  r = await api("/api/reviews/RV-SL-T4/reassign", { method: "POST", body: {} });
  check("显式重派释放超时名额", r.status === 200 && r.data.freed.some(f => f.slot === 2 && f.from === "甲"), r.data);
  rv = await reviewOf("SL-T4");
  check("释放后槽位空缺、未过期名额保留", !rv.slots[1].occupied && rv.slots[0].occupied && rv.status === "盲评中", rv.slots);

  // ========== 场景5：并发抢名额与重复提交 ==========
  const [c1, c2] = await Promise.all([claim("RV-SL-T5", "丙", 1), claim("RV-SL-T5", "丁", 1)]);
  check("并发抢同一名额只有一个成功", [c1.status, c2.status].sort().join(",") === "200,409", { a: c1.status, b: c2.status });
  const tryC = await claim("RV-SL-T5", "丙", 1);
  const tryD = await claim("RV-SL-T5", "丁", 1);
  const holder = tryC.status === 200 ? "丙" : "丁";
  const other = holder === "丙" ? "丁" : "丙";
  check("同一人重复占位幂等、他人占位被拒", (holder === "丙" ? tryC : tryD).status === 200 && (holder === "丙" ? tryD : tryC).status === 409, { tryC: tryC.status, tryD: tryD.status });
  r = await claim("RV-SL-T5", holder, 2);
  check("鉴定员不能重复占位（同一切片两个槽位）", r.status === 409 && r.data.error === "reviewer_duplicate", r);
  await claim("RV-SL-T5", other, 2);
  r = await vote("RV-SL-T5", holder, "砂岩", { 石英: 40, 长石: 35, 云母: 25 });
  check("占位人提交盲评", r.status === 200, r);
  r = await vote("RV-SL-T5", holder, "砂岩", { 石英: 40, 长石: 35, 云母: 25 });
  check("重复提交被拒（不留第二票）", r.status === 409 && r.data.error === "already_submitted", r);
  const [v1, v2] = await Promise.all([
    vote("RV-SL-T5", other, "砂岩", { 石英: 42, 长石: 33, 云母: 25 }),
    vote("RV-SL-T5", other, "砂岩", { 石英: 42, 长石: 33, 云母: 25 })
  ]);
  check("并发重复提交只成功一次", [v1.status, v2.status].sort().join(",") === "200,409", { a: v1.status, b: v2.status });
  rv = await reviewOf("SL-T5");
  check("并发后每槽位仅一票并正常定稿", rv.status === "已定稿" && rv.slots.every(s => s.submitted), rv);

  // ========== 场景6：写入失败回滚，不留部分票、不留临时文件 ==========
  await claim("RV-SL-T6", "甲", 1);
  r = await api("/api/reviews/RV-SL-T6/claim", { method: "POST", body: { reviewer: "乙", slot: 2 }, headers: { "x-test-fail-save": "1" } });
  check("占位写入失败返回错误", r.status === 500, r);
  rv = await reviewOf("SL-T6");
  check("占位写入失败不留部分占位", rv.slots[1].occupied === false, rv.slots);
  r = await vote("RV-SL-T6", "甲", "砂岩", { 石英: 40, 长石: 35, 云母: 25 }, { "x-test-fail-save": "1" });
  check("投票写入失败返回错误", r.status === 500, r);
  rv = await reviewOf("SL-T6");
  check("投票写入失败不留部分票", rv.slots[0].submitted === false && rv.status === "盲评中", rv);
  check("写入失败不留临时文件", (await tmpFiles()).length === 0, await tmpFiles());
  r = await vote("RV-SL-T6", "甲", "砂岩", { 石英: 40, 长石: 35, 云母: 25 });
  check("失败重试后正常提交", r.status === 200 && r.data.slots[0].submitted === true, r.data);
  await claim("RV-SL-T6", "乙", 2);
  r = await vote("RV-SL-T6", "乙", "砂岩", { 石英: 41, 长石: 34, 云母: 25 });
  check("回滚后可正常走通定稿", r.data.status === "已定稿", r.data);

  // ========== 场景7：标准版本只影响新盲评 + 全部观察后批次待观察 ==========
  r = await api("/api/standards", { method: "POST", body: { categories: "砂岩,灰岩,花岗岩,矿化蚀变岩,凝灰岩", tolerance: 2, note: "收紧容差并新增类别" } });
  check("发布新标准版本 v2", r.status === 201 && r.data.version === "v2", r.data);
  await api(`/api/samples/${sid}/slices/SL-T7/logs`, { method: "POST", body: { step: "观察", note: "镜下观察完成" } });
  rv = await reviewOf("SL-T7");
  check("新盲评使用新标准 v2", rv.standardVersion === "v2" && rv.tolerance === 2 && rv.categories.includes("凝灰岩"), rv);
  check("全部切片进入观察后批次显示待观察", (await sampleOf(sid)).status === "待观察", (await sampleOf(sid)).status);
  const rv1 = await reviewOf("SL-T1");
  check("已定稿结果不受新标准影响", rv1.standardVersion === "v1" && rv1.final && rv1.final.ratios["石英"] === 41.5, rv1);

  // ========== 场景8：重启数据仍在 ==========
  await stopServer();
  await startServer({ ALLOW_TEST_HOOKS: "1" });
  const all = (await api("/api/reviews")).data;
  check("重启后盲评数据仍在", all.length === 9 && all.find(x => x.sliceId === "SL-T1").final && all.find(x => x.sliceId === "SL-T3").status === "待处理", all.length);
  const samples = (await api("/api/samples")).data;
  check("重启后旧入口数据仍在", samples.some(s => s.id === sid) && samples.some(s => s.id === "CORE-A"), samples.map(s => s.id));
  check("重启后状态边界保持", (await sampleOf(sid)).status === "待观察" && (await sampleOf("CORE-B")).status === "制片中");

  // ========== 场景9：正式运行不受测试故障开关影响 ==========
  await stopServer();
  await startServer(); // 不设置 ALLOW_TEST_HOOKS，等同正式运行
  await api(`/api/samples/${sid}/slices`, { method: "POST", body: { id: "SL-P1", method: "薄片" } });
  await api(`/api/samples/${sid}/slices/SL-P1/logs`, { method: "POST", body: { step: "观察", note: "观察完成" } });
  r = await api("/api/reviews/RV-SL-P1/claim", { method: "POST", body: { reviewer: "戊", slot: 1 }, headers: { "x-test-fail-save": "1" } });
  check("正式模式忽略故障注入头（占位成功）", r.status === 200, r);
  r = await vote("RV-SL-P1", "戊", "砂岩", { 石英: 40, 长石: 35, 云母: 25 }, { "x-test-fail-save": "1" });
  check("正式模式忽略故障注入头（投票成功）", r.status === 200, r);
  rv = await reviewOf("SL-P1");
  check("正式模式写入真实落盘", rv && rv.slots[0].submitted === true, rv);
  const finalCount = (await api("/api/reviews")).data.length;
  check("正式模式旧数据完整", finalCount === 10 && (await reviewOf("SL-T1")).final, finalCount);

  await stopServer();
  await rm(DB_PATH, { force: true });
  for (const f of await tmpFiles().catch(() => [])) await rm(join(dirname(DB_PATH), f), { force: true });
  console.log(failures ? `\n${failures} 项失败` : "\n全部走查通过");
  process.exit(failures ? 1 : 0);
}

main().catch(async err => {
  console.error(err);
  await stopServer();
  process.exit(1);
});
