const SOURCE_COLOR = {
  tui: "#2f9e8f",
  cron: "#e2a53a",
  desktop: "#8b93f0",
  cli: "#5eb0ff",
  telegram: "#4aa3df",
};

const vscodeApi = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;
let expandAll = false;

const state = {
  hours: 168,
  idle: 120,
  board: null,
  selected: null,
  profileOptions: [],
  sourceOptions: [],
};

const filters = {
  profiles: null,
  sources: null,
  model: "",
  role: "all",
  tool: "",
  q: "",
};

const $ = (id) => document.getElementById(id);

function color(source) {
  return SOURCE_COLOR[source] || "#b7b39a";
}

function fmtDur(seconds) {
  const s = Math.max(0, seconds || 0);
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}초`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 ${Math.round(s % 60)}초`;
  const h = Math.floor(m / 60);
  return `${h}시간 ${m % 60}분`;
}

function fmtWhen(epoch) {
  if (!epoch) return "—";
  const d = new Date(epoch * 1000);
  return d.toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function tickLabel(epoch, span) {
  const d = new Date(epoch * 1000);
  if (span <= 36 * 3600) {
    return d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
}

function escapeText(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

function escapeAttr(value) {
  return escapeText(value);
}

function cssEscape(value) {
  if (window.CSS && CSS.escape) return CSS.escape(value);
  return String(value).replace(/"/g, '\\"');
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== undefined && value !== null && value !== ""))].sort();
}

function allSessions(board) {
  return board.profiles.flatMap((profile) => profile.sessions);
}

function keepSet(current, options) {
  if (!current) return new Set(options);
  const next = new Set([...current].filter((value) => options.includes(value)));
  return next.size ? next : new Set(options);
}

async function load(fresh = false) {
  const idle = Number($("idle").value);
  state.idle = idle;
  const now = Date.now() / 1000;
  let start;
  let end = now;
  if (state.hours === 0 && state.board?.range) {
    start = state.board.range.start;
    end = Math.max(now, state.board.range.end);
  } else if (state.hours === 0) {
    start = now - 86400 * 120;
  } else {
    start = now - state.hours * 3600;
  }
  const q = new URLSearchParams({
    start: String(start),
    end: String(end),
    idle: String(idle),
    fresh: fresh ? "1" : "0",
  });
  $("gantt").innerHTML = '<p class="empty">state.db를 읽는 중입니다.</p>';
  if (vscodeApi) {
    expandAll = state.hours === 0 && !state.board?.range;
    vscodeApi.postMessage({ type: "board", start, end, idle: state.idle, fresh });
    return;
  }
  const res = await fetch(`/api/board?${q}`);
  const board = await res.json();
  if (!res.ok) {
    $("gantt").innerHTML = `<p class="error">${board.error || "읽기 실패"}</p>`;
    return;
  }
  if (state.hours === 0) {
    const q2 = new URLSearchParams({
      start: String(board.range.start),
      end: String(Math.max(now, board.range.end)),
      idle: String(idle),
    });
    const res2 = await fetch(`/api/board?${q2}`);
    state.board = await res2.json();
  } else {
    state.board = board;
  }
  render();
}

function visibleSessions(board) {
  const q = filters.q.trim().toLowerCase();
  return allSessions(board).filter((session) => {
    if (filters.profiles && !filters.profiles.has(session.profile)) return false;
    if (filters.sources && !filters.sources.has(session.source)) return false;
    if (filters.model && session.model !== filters.model) return false;
    if (filters.role === "root" && session.child) return false;
    if (filters.role === "child" && !session.child) return false;
    if (filters.tool && !(session.tools || []).some((tool) => tool.name === filters.tool)) return false;
    if (q && !`${session.title || ""} ${session.id}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function presenceIntervals(sessions) {
  const intervals = [];
  for (const session of sessions) {
    for (const [start, end] of session.bursts) {
      intervals.push(end <= start ? [start, start + 1] : [start, end]);
    }
  }
  return intervals;
}

function lifeIntervals(sessions) {
  return sessions.map((session) => [session.started_at, Math.max(session.closed_at, session.started_at)]);
}

function stepSeries(intervals, start, end) {
  const events = [];
  for (const [a, b] of intervals) {
    let lo = Math.max(a, start);
    let hi = Math.min(b, end);
    if (hi < start || lo > end || hi < lo) continue;
    if (hi === lo) hi = Math.min(end, lo + 1);
    events.push([lo, 1], [hi, -1]);
  }
  events.sort((left, right) => left[0] - right[0] || right[1] - left[1]);
  const points = [[start, 0]];
  let current = 0;
  for (const [t, delta] of events) {
    if (points[points.length - 1][0] !== t) points.push([t, current]);
    current += delta;
    points.push([t, current]);
  }
  if (points[points.length - 1][0] !== end) points.push([end, current]);
  return points;
}

function peakOf(points) {
  let best = 0;
  let at = null;
  for (const [t, n] of points) {
    if (n > best) {
      best = n;
      at = t;
    }
  }
  return [best, at];
}

function orderRows(rows) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const kids = new Map();
  const roots = [];
  for (const row of rows) {
    if (row.parent_id && byId.has(row.parent_id)) {
      if (!kids.has(row.parent_id)) kids.set(row.parent_id, []);
      kids.get(row.parent_id).push(row);
    } else {
      roots.push(row);
    }
  }
  const key = (row) => (row.bursts[0] ? row.bursts[0][0] : row.started_at);
  roots.sort((a, b) => key(a) - key(b));
  const ordered = [];
  const seen = new Set();
  const walk = (row) => {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    ordered.push(row);
    for (const child of (kids.get(row.id) || []).sort((a, b) => key(a) - key(b))) walk(child);
  };
  roots.forEach(walk);
  for (const row of rows) {
    if (!seen.has(row.id)) ordered.push(row);
  }
  return ordered;
}

function toolTotals(sessions) {
  const map = new Map();
  for (const session of sessions) {
    for (const tool of session.tools || []) {
      const current = map.get(tool.name) || { name: tool.name, total_s: 0, count: 0 };
      current.total_s += tool.total_s;
      current.count += tool.count;
      map.set(tool.name, current);
    }
  }
  return [...map.values()].sort((a, b) => b.total_s - a.total_s);
}

function render() {
  const board = state.board;
  if (!board) return;
  const sessions = allSessions(board);
  state.profileOptions = unique(sessions.map((session) => session.profile));
  state.sourceOptions = unique(sessions.map((session) => session.source));
  filters.profiles = keepSet(filters.profiles, state.profileOptions);
  filters.sources = keepSet(filters.sources, state.sourceOptions);
  const models = unique(sessions.map((session) => session.model));
  const tools = unique(sessions.flatMap((session) => (session.tools || []).map((tool) => tool.name)));
  fillSelect("filter-model", models, filters.model);
  fillSelect("filter-tool", tools, filters.tool);
  filters.model = $("filter-model").value;
  filters.tool = $("filter-tool").value;
  paintChips();

  const shown = visibleSessions(board);
  const win = board.window;
  const working = stepSeries(presenceIntervals(shown), win.start, win.end);
  const opened = stepSeries(lifeIntervals(shown), win.start, win.end);
  const [workPeak, workAt] = peakOf(working);
  const [openPeak] = peakOf(opened);
  const childIntervals = presenceIntervals(shown.filter((session) => session.child));
  const [childPeak] = peakOf(stepSeries(childIntervals, win.start, win.end));
  const modelS = shown.reduce((sum, session) => sum + (session.model_s || 0), 0);
  const toolsAgg = toolTotals(shown);
  const toolS = toolsAgg.reduce((sum, tool) => sum + tool.total_s, 0);
  const bursts = shown.reduce((sum, session) => sum + session.bursts.length, 0);

  const stores = board.stores.map((store) => `${store.profile} ${store.sessions}세션`).join(" · ");
  $("home").textContent = `${board.home} · ${stores} · 화면 ${shown.length}/${sessions.length}`;
  $("stats").innerHTML = [
    ["동시 작업 피크", workPeak, fmtWhen(workAt)],
    ["그중 서브에이전트", childPeak, filters.role === "child" ? "서브만" : "필터 반영"],
    ["열린 세션 피크", openPeak, "수명 기준"],
    ["이 구간의 작업", shown.length, `${bursts}개 버스트`],
    ["모델 / 도구", fmtDur(modelS), fmtDur(toolS)],
  ].map(([label, value, sub]) => `<div class="stat"><span>${label}</span><b>${value}</b><span>${sub}</span></div>`).join("");

  drawChart($("chart-working"), working, "#3dba8b", workPeak);
  drawSourceLines(board, shown);
  drawChart($("chart-open"), opened, "#8d9078", openPeak);
  drawSourceBars(shown);
  drawSessionBars(shown);
  drawToolBars(toolsAgg);
  drawHistogram(shown);
  drawSplit(modelS, toolS);
  drawAxis(win);
  drawGantt(board, shown);
  drawSide(board, shown, toolsAgg);
  applyPlayhead();
}

function fillSelect(id, values, current) {
  const el = $(id);
  const sig = values.join("|");
  if (el.dataset.sig !== sig) {
    el.dataset.sig = sig;
    el.innerHTML = `<option value="">전체</option>${values.map((value) => `<option value="${escapeAttr(value)}">${escapeText(value)}</option>`).join("")}`;
  }
  el.value = values.includes(current) ? current : "";
}

function paintChips() {
  $("filter-profile").innerHTML = state.profileOptions.map((name) =>
    `<button type="button" class="chip${filters.profiles.has(name) ? " on" : ""}" data-kind="profile" data-value="${escapeAttr(name)}">${escapeText(name)}</button>`
  ).join("") || '<span class="muted">없음</span>';
  $("filter-source").innerHTML = state.sourceOptions.map((name) =>
    `<button type="button" class="chip${filters.sources.has(name) ? " on" : ""}" data-kind="source" data-value="${escapeAttr(name)}"><i class="dot" style="background:${color(name)}"></i>${escapeText(name)}</button>`
  ).join("") || '<span class="muted">없음</span>';
}

function drawChart(svg, points, stroke, peak) {
  const w = 1000;
  const h = svg.viewBox.baseVal.height || 140;
  if (!points.length) {
    svg.innerHTML = "";
    return;
  }
  const max = Math.max(peak || 0, 1, ...points.map((point) => point[1]));
  const x = (t) => {
    const a = points[0][0];
    const b = points[points.length - 1][0];
    return ((t - a) / (b - a || 1)) * (w - 8) + 4;
  };
  const y = (n) => h - 16 - (n / max) * (h - 28);
  let d = "";
  points.forEach((point, i) => {
    d += `${i === 0 ? "M" : "L"}${x(point[0]).toFixed(1)},${y(point[1]).toFixed(1)}`;
  });
  const area = `${d} L${x(points[points.length - 1][0]).toFixed(1)},${h - 16} L${x(points[0][0]).toFixed(1)},${h - 16} Z`;
  svg.innerHTML = `
    <path d="${area}" fill="${stroke}" opacity="0.18"></path>
    <path d="${d}" fill="none" stroke="${stroke}" stroke-width="2"></path>
    <text class="peak-label" x="8" y="14">피크 ${peak}</text>`;
}

function drawSourceLines(board, sessions, cursor) {
  const svg = $("chart-source");
  const win = board.window;
  const limit = cursor == null ? win.end : cursor;
  const sources = unique(sessions.map((session) => session.source));
  const series = sources.map((source) => {
    const points = stepSeries(
      clipIntervals(presenceIntervals(sessions.filter((session) => session.source === source)), limit),
      win.start,
      win.end,
    );
    return { source, points, peak: peakOf(points)[0] };
  });
  const max = Math.max(1, ...series.map((item) => item.peak));
  const h = 150;
  const x = (t) => ((t - win.start) / (win.end - win.start || 1)) * 992 + 4;
  const y = (n) => h - 16 - (n / max) * (h - 28);
  svg.innerHTML = series.map((item) => {
    const d = item.points.map((point, i) => `${i === 0 ? "M" : "L"}${x(point[0]).toFixed(1)},${y(point[1]).toFixed(1)}`).join("");
    return `<path d="${d}" fill="none" stroke="${color(item.source)}" stroke-width="2"></path>`;
  }).join("") + `<text class="peak-label" x="8" y="14">출처 ${sources.length}</text>`;
  $("source-legend").innerHTML = series.map((item) =>
    `<button type="button" data-source="${escapeAttr(item.source)}"><i class="dot" style="background:${color(item.source)}"></i>${escapeText(item.source)} 피크 ${item.peak}</button>`
  ).join("");
}

function hbars(svg, rows, fill, onPick) {
  const width = 420;
  const labelW = 108;
  const top = 16;
  if (!rows.length) {
    svg.innerHTML = '<text x="8" y="28" fill="#9a947f" font-size="12">이 필터에는 없습니다</text>';
    return;
  }
  const shown = rows.slice(0, 7);
  const max = Math.max(...shown.map((row) => row.value), 1);
  const barH = 22;
  svg.innerHTML = shown.map((row, i) => {
    const y = top + i * (barH + 6);
    const bar = ((width - labelW - 78) * row.value) / max;
    return `<text x="4" y="${y + 14}" fill="#9a947f" font-size="11">${escapeText(String(row.label).slice(0, 14))}</text>
      <rect data-key="${escapeAttr(row.key)}" x="${labelW}" y="${y}" width="${Math.max(bar, 1)}" height="${barH - 4}" fill="${fill(row)}" style="cursor:pointer"></rect>
      <text x="${labelW + bar + 6}" y="${y + 14}" fill="#ebe6d6" font-size="11">${row.text}</text>`;
  }).join("");
  if (!onPick) return;
  svg.querySelectorAll("rect").forEach((rect) => {
    rect.addEventListener("click", () => onPick(rect.dataset.key));
  });
}

function drawSourceBars(sessions) {
  const map = new Map();
  for (const session of sessions) map.set(session.source, (map.get(session.source) || 0) + session.active_s);
  const rows = [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([source, value]) => ({ key: source, label: source, value, text: fmtDur(value) }));
  hbars($("chart-source-bar"), rows, (row) => color(row.key), (source) => {
    filters.sources = new Set([source]);
    render();
  });
}

function drawSessionBars(sessions) {
  const rows = [...sessions]
    .sort((a, b) => b.active_s - a.active_s)
    .slice(0, 7)
    .filter((session) => session.active_s > 0)
    .map((session) => ({
      key: `${session.profile}\t${session.id}`,
      label: session.title || session.id,
      value: session.active_s,
      text: fmtDur(session.active_s),
    }));
  hbars($("chart-sessions"), rows, () => "#3dba8b", (key) => {
    const [profile, id] = key.split("\t");
    const row = document.querySelector(`.row[data-id="${cssEscape(id)}"]`);
    if (row) row.scrollIntoView({ block: "center" });
    openSession(profile, id, row);
  });
}

function drawToolBars(tools) {
  const rows = tools.slice(0, 7).map((tool) => ({
    key: tool.name,
    label: tool.name,
    value: tool.total_s,
    text: fmtDur(tool.total_s),
  }));
  hbars($("chart-tools"), rows, () => "#e2a53a", (name) => {
    filters.tool = name;
    $("filter-tool").value = name;
    render();
  });
}

function drawHistogram(sessions) {
  const buckets = [
    { label: "<10초", max: 10 },
    { label: "<30초", max: 30 },
    { label: "<2분", max: 120 },
    { label: "<5분", max: 300 },
    { label: "<15분", max: 900 },
    { label: "<1시간", max: 3600 },
    { label: "1시간+", max: Infinity },
  ];
  const counts = buckets.map(() => 0);
  for (const session of sessions) {
    for (const [start, end] of session.bursts) {
      const duration = Math.max(0, end - start);
      const index = buckets.findIndex((bucket) => duration < bucket.max);
      counts[index === -1 ? counts.length - 1 : index] += 1;
    }
  }
  const svg = $("chart-hist");
  const max = Math.max(...counts, 1);
  const barW = 46;
  svg.innerHTML = counts.map((count, i) => {
    const h = (count / max) * 140;
    const x = 18 + i * (barW + 8);
    const y = 168 - h;
    return `<rect x="${x}" y="${y}" width="${barW}" height="${Math.max(h, count ? 2 : 0)}" fill="#7f9cf5"></rect>
      <text x="${x + barW / 2}" y="${y - 4}" text-anchor="middle" fill="#ebe6d6" font-size="11">${count}</text>
      <text x="${x + barW / 2}" y="192" text-anchor="middle" fill="#9a947f" font-size="10">${buckets[i].label}</text>`;
  }).join("");
}

function drawSplit(modelS, toolS) {
  const total = modelS + toolS || 1;
  $("split-bar").innerHTML = `
    <div class="splitmeter">
      <i class="model" style="width:${(modelS / total) * 100}%"></i>
      <i class="tool" style="width:${(toolS / total) * 100}%"></i>
    </div>
    <div class="legend"><span>모델 대기 ${fmtDur(modelS)}</span><span>도구 ${fmtDur(toolS)}</span></div>`;
}

function drawAxis(window) {
  const span = window.end - window.start;
  const ticks = [];
  const count = 6;
  for (let i = 0; i <= count; i++) ticks.push(window.start + (span * i) / count);
  $("axis").innerHTML = `<div></div><div class="ticks">${ticks
    .map((t, i) => `<i style="left:${(i / count) * 100}%">${tickLabel(t, span)}</i>`)
    .join("")}</div>`;
}

function pct(t, window) {
  return ((t - window.start) / (window.end - window.start || 1)) * 100;
}

function drawGantt(board, sessions) {
  const host = $("gantt");
  if (!sessions.length) {
    host.innerHTML = '<p class="empty">이 필터에 해당하는 작업 버스트가 없습니다. 출처나 기간을 바꿔 보세요.</p>';
    return;
  }
  const byProfile = new Map();
  for (const session of sessions) {
    if (!byProfile.has(session.profile)) byProfile.set(session.profile, []);
    byProfile.get(session.profile).push(session);
  }
  host.innerHTML = [...byProfile.keys()].sort().map((name) => {
    const rows = orderRows(byProfile.get(name));
    const peak = peakOf(stepSeries(presenceIntervals(rows), board.window.start, board.window.end))[0];
    return `<div class="lane">
      <div class="lane-head"><span>${escapeText(name)}</span><span>작업 피크 <b>${peak}</b> · ${rows.length}개 세션</span></div>
      ${rows.map((session) => rowHtml(session, board.window)).join("")}
    </div>`;
  }).join("");
  host.querySelectorAll(".row").forEach((el) => {
    el.addEventListener("click", () => openSession(el.dataset.profile, el.dataset.id, el));
  });
}

function rowHtml(session, window) {
  const label = session.title || session.id;
  const lifeL = Math.max(0, pct(session.started_at, window));
  const lifeR = Math.min(100, pct(session.closed_at, window));
  const bursts = session.bursts.map(([a, b]) => {
    const left = pct(a, window);
    const width = Math.max(0.4, pct(Math.max(b, a + 1), window) - left);
    return `<i class="burst" data-start="${a}" data-end="${b}" style="left:${left}%;width:${width}%;background:${color(session.source)}" title="${fmtDur(Math.max(0, b - a))}"></i>`;
  }).join("");
  const selected = state.selected === `${session.profile}:${session.id}` ? " on" : "";
  return `<div class="row${session.child ? " child" : ""}${selected}" data-profile="${escapeAttr(session.profile)}" data-id="${escapeAttr(session.id)}">
    <div class="label" title="${escapeAttr(label)}"><span class="src" style="background:${color(session.source)}">${escapeText(session.source)}</span>${escapeText(label)}</div>
    <div class="track"><i class="life" style="left:${lifeL}%;width:${Math.max(0, lifeR - lifeL)}%"></i>${bursts}</div>
  </div>`;
}

function drawSide(board, sessions, tools) {
  const ids = new Set(sessions.map((session) => `${session.profile}:${session.id}`));
  const maxTool = Math.max(...tools.map((tool) => tool.total_s), 1);
  $("tools").innerHTML = tools.length
    ? tools.slice(0, 12).map((tool) => `<div class="tool"><span>${escapeText(tool.name)}</span><div class="bar"><span style="width:${(tool.total_s / maxTool) * 100}%"></span></div><span>${fmtDur(tool.total_s)}</span></div>`).join("")
    : '<p class="muted">이 필터에 도구 간격이 없습니다.</p>';
  const slow = (board.slow_calls || []).filter((call) => ids.has(`${call.profile}:${call.session_id}`));
  $("slow").innerHTML = slow.map((call) =>
    `<li data-profile="${escapeAttr(call.profile)}" data-id="${escapeAttr(call.session_id)}">${escapeText(call.tool)} · ${fmtDur(call.duration_s)}<br><span class="muted">${escapeText(call.title)}</span></li>`
  ).join("") || '<li class="muted">없음</li>';
  $("slow").querySelectorAll("li[data-id]").forEach((li) => {
    li.addEventListener("click", () => {
      const row = document.querySelector(`.row[data-id="${cssEscape(li.dataset.id)}"]`);
      if (row) row.scrollIntoView({ block: "center" });
      openSession(li.dataset.profile, li.dataset.id, row);
    });
  });
}

function showDetail(data) {
  if (!data || data.error) {
    $("detail").textContent = (data && data.error) || "세션을 찾지 못했습니다.";
    return;
  }
  const max = Math.max(...data.spans.map((span) => span.duration_s), 1);
  const bars = data.spans.slice(0, 240).map((span) => `<div class="span"><span>${escapeText(span.name)}</span><div class="bar"><span class="kind-${span.kind}" style="width:${(span.duration_s / max) * 100}%"></span></div><span>${fmtDur(span.duration_s)}</span></div>`).join("");
  $("detail").innerHTML = `
    <p><b>${escapeText(data.title || data.id)}</b><br><span class="muted">${escapeText(data.source)} · ${escapeText(data.model || "model")} · 유휴로 뺀 시간 ${fmtDur(data.idle_omitted_s)}</span></p>
    ${bars || '<p class="muted">간격이 없습니다.</p>'}
    ${data.spans.length > 240 ? '<p class="muted">앞 240개 간격만 표시합니다.</p>' : ""}`;
}

async function openSession(profile, id, row) {
  state.selected = `${profile}:${id}`;
  document.querySelectorAll(".row.on").forEach((el) => el.classList.remove("on"));
  if (row) row.classList.add("on");
  $("detail").textContent = "간격을 계산하는 중";
  if (vscodeApi) {
    vscodeApi.postMessage({ type: "session", profile, id, idle: state.idle });
    return;
  }
  const q = new URLSearchParams({ profile, id, idle: String(state.idle) });
  const res = await fetch(`/api/session?${q}`);
  const data = await res.json();
  if (!res.ok) {
    $("detail").textContent = data.error || "세션을 찾지 못했습니다.";
    return;
  }
  showDetail(data);
}

function toggleChip(kind, value) {
  const set = kind === "profile" ? filters.profiles : filters.sources;
  const options = kind === "profile" ? state.profileOptions : state.sourceOptions;
  if (set.has(value) && set.size === options.length) {
    set.clear();
    set.add(value);
  } else if (set.has(value)) {
    set.delete(value);
    if (!set.size) options.forEach((item) => set.add(item));
  } else {
    set.add(value);
  }
  render();
}

$("filters").addEventListener("click", (event) => {
  const chip = event.target.closest(".chip");
  if (!chip) return;
  toggleChip(chip.dataset.kind, chip.dataset.value);
});
$("source-legend").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  toggleChip("source", button.dataset.source);
});
$("filter-model").addEventListener("change", () => {
  filters.model = $("filter-model").value;
  render();
});
$("filter-role").addEventListener("change", () => {
  filters.role = $("filter-role").value;
  render();
});
$("filter-tool").addEventListener("change", () => {
  filters.tool = $("filter-tool").value;
  render();
});
$("filter-q").addEventListener("input", () => {
  filters.q = $("filter-q").value;
  render();
});
$("filter-clear").addEventListener("click", () => {
  filters.profiles = new Set(state.profileOptions);
  filters.sources = new Set(state.sourceOptions);
  filters.model = "";
  filters.role = "all";
  filters.tool = "";
  filters.q = "";
  $("filter-model").value = "";
  $("filter-role").value = "all";
  $("filter-tool").value = "";
  $("filter-q").value = "";
  render();
});
$("presets").addEventListener("click", (event) => {
  const btn = event.target.closest("button");
  if (!btn) return;
  state.hours = Number(btn.dataset.hours);
  $("presets").querySelectorAll("button").forEach((el) => el.classList.toggle("on", el === btn));
  load(false);
});
$("idle").addEventListener("change", () => load(false));
$("reload").addEventListener("click", () => load(true));
window.addEventListener("message", (event) => {
  const msg = event.data || {};
  if (msg.type === "error") {
    $("gantt").innerHTML = `<p class="error">${escapeText(msg.message || "읽기 실패")}</p>`;
    return;
  }
  if (msg.type === "session") {
    showDetail(msg.session);
    return;
  }
  if (msg.type !== "board") return;
  if (!msg.ok) {
    $("gantt").innerHTML = `<p class="error">${escapeText(msg.error || "읽기 실패")}</p>`;
    return;
  }
  if (expandAll) {
    expandAll = false;
    const now = Date.now() / 1000;
    vscodeApi.postMessage({
      type: "board",
      start: msg.board.range.start,
      end: Math.max(now, msg.board.range.end),
      idle: state.idle,
      fresh: false,
    });
    return;
  }
  state.board = msg.board;
  if (play.live) play.t = msg.board.window.end;
  render();
});

const play = { running: false, live: false, t: null, raf: 0 };

function clipIntervals(intervals, cursor) {
  const out = [];
  for (const [start, end] of intervals) {
    if (start >= cursor) continue;
    const hi = Math.min(end, cursor);
    if (hi > start) out.push([start, hi]);
  }
  return out;
}

function cursorOf(board) {
  if (play.t == null) return board.window.end;
  return Math.min(board.window.end, Math.max(board.window.start, play.t));
}

function applyPlayhead() {
  const board = state.board;
  if (!board) return;
  const cursor = cursorOf(board);
  const win = board.window;
  const shown = visibleSessions(board);
  const working = stepSeries(clipIntervals(presenceIntervals(shown), cursor), win.start, win.end);
  const opened = stepSeries(clipIntervals(lifeIntervals(shown), cursor), win.start, win.end);
  drawChart($("chart-working"), working, "#3dba8b", peakOf(working)[0]);
  drawSourceLines(board, shown, cursor);
  drawChart($("chart-open"), opened, "#8d9078", peakOf(opened)[0]);
  const pctPos = ((cursor - win.start) / (win.end - win.start || 1)) * 100;
  const showLine = play.running || play.live;
  document.querySelectorAll(".figure-playhead").forEach((el) => {
    if (el.id === "gantt-playhead") return;
    el.hidden = !showLine;
    el.style.left = `${pctPos}%`;
  });
  const ganttHead = $("gantt-playhead");
  if (ganttHead) {
    ganttHead.hidden = !showLine;
    const wrap = document.querySelector(".gantt-wrap");
    const label = wrap && wrap.clientWidth < 700 ? 140 : 260;
    const width = Math.max(1, (wrap ? wrap.clientWidth : 800) - label);
    ganttHead.style.left = `${label + (pctPos / 100) * width}px`;
  }
  document.querySelectorAll(".burst").forEach((el) => {
    const start = Number(el.dataset.start);
    const end = Number(el.dataset.end);
    if (start >= cursor) {
      el.style.visibility = "hidden";
      return;
    }
    el.style.visibility = "visible";
    const left = pct(start, win);
    el.style.left = `${left}%`;
    el.style.width = `${Math.max(0.4, pct(Math.min(end, cursor), win) - left)}%`;
  });
  const clock = $("play-time");
  if (clock) clock.textContent = fmtWhen(cursor);
}

function armPlayback() {
  if (play.raf) cancelAnimationFrame(play.raf);
  play.raf = 0;
  document.body.classList.toggle("playing", play.running);
  if (!play.running) return;
  let last = performance.now();
  const step = (now) => {
    if (!play.running || !state.board) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const win = state.board.window;
    const span = Math.max(1, Number($("play-span").value || 12));
    if (play.t == null || play.t < win.start || play.t > win.end) play.t = win.start;
    play.t += dt * ((win.end - win.start) / span);
    if (play.t >= win.end) play.t = play.live ? win.end : win.start;
    applyPlayhead();
    play.raf = requestAnimationFrame(step);
  };
  play.raf = requestAnimationFrame(step);
}

$("play").addEventListener("click", () => {
  play.running = !play.running;
  $("play").classList.toggle("on", play.running);
  $("play").textContent = play.running ? "일시정지" : "재생";
  if (play.running && state.board) play.t = state.board.window.start;
  armPlayback();
  if (!play.running) applyPlayhead();
});
$("live").addEventListener("click", () => {
  play.live = !play.live;
  $("live").classList.toggle("on", play.live);
  if (play.live && state.board) {
    play.t = state.board.window.end;
    applyPlayhead();
  }
});
setInterval(() => {
  if (!play.live || !vscodeApi || !state.board) return;
  const now = Date.now() / 1000;
  const start = state.hours === 0 ? state.board.range.start : now - state.hours * 3600;
  vscodeApi.postMessage({ type: "board", start, end: now, idle: state.idle, fresh: true });
}, 4000);
load(false);
