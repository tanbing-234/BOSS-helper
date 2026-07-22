const ids = [
  "apiBaseUrl", "apiKey", "model", "resumeText", "strengths", "targetRoles",
  "targetCities", "minimumSalaryK", "minimumScore", "greetingMaxLength",
  "searchKeywordCount",
  "excludedKeywords", "autoSend", "status", "historySummary", "connectionStatus",
  "autoApplyIntervalSeconds", "chatReplyIntervalSeconds", "chatAutoSend", "chatSendResume"
  ,"precomputedSearchKeywords", "searchKeywordStatus"
];
const ui = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
let wordCloudRefreshTimer;
let wordCloudSnapshot = { whitelist: [], archives: [] };
let settingsCache = {};
let whitelistDirty = false;

document.getElementById("save").addEventListener("click", save);
document.getElementById("clearHistory").addEventListener("click", clearHistory);
document.getElementById("testConnection").addEventListener("click", testConnection);
document.getElementById("addWhitelist").addEventListener("click", () => appendWhitelistRow({}));
document.getElementById("saveWhitelist").addEventListener("click", saveWhitelist);
document.getElementById("exportWhitelist").addEventListener("click", exportWhitelistCsv);
document.getElementById("generateSearchKeywords").addEventListener("click", generateAndSaveSearchKeywords);
document.getElementById("toggleWhitelist").addEventListener("click", () => toggleOptionsPanel("whitelistContent", "toggleWhitelist"));
document.getElementById("toggleChatKnowledge").addEventListener("click", () => toggleOptionsPanel("chatKnowledgeContent", "toggleChatKnowledge"));
document.getElementById("searchWhitelist").addEventListener("click", filterWhitelistRows);
document.getElementById("searchChatKnowledge").addEventListener("click", filterChatKnowledgeRows);
ui.apiBaseUrl.addEventListener("input", invalidateConnection);
ui.apiKey.addEventListener("input", invalidateConnection);
load();

async function load() {
  const { settings = {}, history = {}, applicationWhitelist = [], applicationArchives = [], deliveryReports = [], chatKnowledge = [] } = await chrome.storage.local.get(["settings", "history", "applicationWhitelist", "applicationArchives", "deliveryReports", "chatKnowledge"]);
  const repaired = repairApplicationRecords(applicationWhitelist, applicationArchives, history, deliveryReports);
  const cleanedArchives = repaired.archives.map((archive) => ({ ...archive, description: cleanStoredDescription(archive.description || "") }));
  const archivesChanged = JSON.stringify(cleanedArchives) !== JSON.stringify(repaired.archives);
  repaired.archives = cleanedArchives;
  if (repaired.changed || archivesChanged) {
    await chrome.storage.local.set({ applicationWhitelist: repaired.whitelist, applicationArchives: cleanedArchives });
  }
  const profile = settings.profile || {};
  settingsCache = settings;
  ui.apiBaseUrl.value = settings.apiBaseUrl || "https://api.openai.com/v1";
  ui.apiKey.value = settings.apiKey || "";
  const availableModels = settings.availableModels || [];
  setModelOptions(availableModels, availableModels.includes(settings.model) ? settings.model : "");
  ui.resumeText.value = profile.resumeText || "";
  ui.strengths.value = profile.strengths || "";
  ui.targetRoles.value = (profile.targetRoles || []).join(", ");
  ui.targetCities.value = (profile.targetCities || []).join(", ");
  ui.minimumSalaryK.value = profile.minimumSalaryK ?? 0;
  ui.minimumScore.value = settings.minimumScore ?? 70;
  ui.searchKeywordCount.value = settings.searchKeywordCount ?? 16;
  ui.precomputedSearchKeywords.value = (settings.precomputedSearchKeywords || []).join("\n");
  ui.greetingMaxLength.value = settings.greetingMaxLength ?? 180;
  ui.excludedKeywords.value = (profile.excludedKeywords || []).join(", ");
  ui.autoSend.checked = Boolean(settings.autoSend);
  ui.autoApplyIntervalSeconds.value = settings.autoApplyIntervalSeconds ?? 8;
  ui.chatReplyIntervalSeconds.value = settings.chatReplyIntervalSeconds ?? 8;
  ui.chatAutoSend.checked = Boolean(settings.chatAutoSend);
  ui.chatSendResume.checked = settings.chatSendResume !== false;
  renderHistory(history);
  const normalizedWhitelist = repaired.whitelist.map((entry) => ({
    ...entry,
    expectedSalary: decodeBossText(entry.expectedSalary)
  }));
  renderWhitelist(normalizedWhitelist);
  if (JSON.stringify(normalizedWhitelist) !== JSON.stringify(repaired.whitelist)) {
    await chrome.storage.local.set({ applicationWhitelist: normalizedWhitelist });
  }
  renderWhitelistWordClouds(normalizedWhitelist, repaired.archives);
  renderChatKnowledge(chatKnowledge);
  await restoreOptionsPanels();
}

function repairApplicationRecords(whitelist, archives, history, reports) {
  const normalized = (value) => String(value || "").toLowerCase().replace(/[\s·•()（）【】\[\]_-]/g, "");
  const resultWhitelist = [...whitelist];
  const resultArchives = [...archives];
  let changed = false;
  const hasWhitelist = (company, title) => resultWhitelist.some((item) => normalized(item.company) === normalized(company) && normalized(item.jobTitle) === normalized(title));
  const hasArchive = (company, title) => resultArchives.some((item) => normalized(item.company) === normalized(company) && normalized(item.jobTitle) === normalized(title));
  for (const item of Object.values(history || {})) {
    if (item.status !== "sent" || !item.company || !item.title || hasWhitelist(item.company, item.title)) continue;
    resultWhitelist.push({ id: crypto.randomUUID(), company: item.company, jobTitle: item.title, expectedSalary: decodeBossText(item.salary || ""), addedAt: item.savedAt || new Date().toISOString() });
    changed = true;
  }
  for (const report of reports || []) {
    for (const job of report.jobs || []) {
      if (!job.company || !job.jobTitle) continue;
      if (!hasWhitelist(job.company, job.jobTitle)) {
        resultWhitelist.push({ id: crypto.randomUUID(), company: job.company, jobTitle: job.jobTitle, expectedSalary: decodeBossText(job.salary || ""), addedAt: report.endedAt || new Date().toISOString() });
        changed = true;
      }
      if (!hasArchive(job.company, job.jobTitle)) {
        resultArchives.push({
          id: crypto.randomUUID(), company: job.company, jobTitle: job.jobTitle, salary: decodeBossText(job.salary || ""),
          platform: String(report.mode || "").includes("zhilian") ? "zhilian" : "boss",
          description: cleanStoredDescription(job.description || job.workSummary || ""), score: job.score ?? null, matchedStrengths: [], greeting: "",
          url: job.url || "", appliedAt: report.endedAt || new Date().toISOString(), recoveredFromReport: true
        });
        changed = true;
      }
    }
  }
  return { whitelist: resultWhitelist, archives: resultArchives.slice(-500), changed };
}

function renderWhitelist(entries) {
  const container = document.getElementById("whitelistRows");
  container.replaceChildren();
  entries.forEach(appendWhitelistRow);
  updateWhitelistEmpty();
}

function appendWhitelistRow(entry = {}) {
  const row = document.createElement("tr");
  row.dataset.id = entry.id || crypto.randomUUID();
  row.dataset.addedAt = entry.addedAt || new Date().toISOString();
  row.append(
    whitelistInputCell("company", entry.company, "企业名称"),
    whitelistInputCell("jobTitle", entry.jobTitle, "岗位名称"),
    whitelistInputCell("expectedSalary", entry.expectedSalary, "例如 12-18K")
  );
  const actionCell = document.createElement("td");
  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "secondary";
  removeButton.textContent = "删除";
  removeButton.addEventListener("click", () => {
    whitelistDirty = true;
    row.remove();
    updateWhitelistEmpty();
    scheduleWordCloudRefresh();
  });
  actionCell.append(removeButton);
  row.append(actionCell);
  document.getElementById("whitelistRows").append(row);
  updateWhitelistEmpty();
}

function whitelistInputCell(field, value = "", placeholder = "") {
  const cell = document.createElement("td");
  const input = document.createElement("input");
  input.dataset.field = field;
  input.value = value || "";
  input.placeholder = placeholder;
  input.addEventListener("input", scheduleWordCloudRefresh);
  input.addEventListener("input", () => { whitelistDirty = true; });
  cell.append(input);
  return cell;
}

async function saveWhitelist() {
  const rows = [...document.querySelectorAll("#whitelistRows tr")];
  const applicationWhitelist = rows.map((row) => ({
    id: row.dataset.id || crypto.randomUUID(),
    company: row.querySelector("[data-field='company']").value.trim(),
    jobTitle: row.querySelector("[data-field='jobTitle']").value.trim(),
    expectedSalary: row.querySelector("[data-field='expectedSalary']").value.trim(),
    addedAt: row.dataset.addedAt || new Date().toISOString()
  })).filter((entry) => entry.company && entry.jobTitle);
  await chrome.storage.local.set({ applicationWhitelist });
  whitelistDirty = false;
  renderWhitelist(applicationWhitelist);
  const { applicationArchives = [] } = await chrome.storage.local.get("applicationArchives");
  renderWhitelistWordClouds(applicationWhitelist, applicationArchives);
  setStatus(`白名单已保存，共 ${applicationWhitelist.length} 条`);
}

function updateWhitelistEmpty() {
  const empty = document.getElementById("whitelistRows").children.length === 0;
  document.getElementById("whitelistEmpty").style.display = empty ? "block" : "none";
}

function decodeBossText(value) {
  return String(value || "").replace(/[\uE031-\uE03A]/g, (character) => String(character.charCodeAt(0) - 0xE031));
}

async function exportWhitelistCsv() {
  const { applicationWhitelist = [], applicationArchives = [] } = await chrome.storage.local.get(["applicationWhitelist", "applicationArchives"]);
  const entries = applicationWhitelist.map((entry) => ({ ...entry, expectedSalary: decodeBossText(entry.expectedSalary) }));
  const headers = ["企业名称", "岗位名称", "期望薪资", "平台", "原匹配分", "投递时间", "岗位Base", "匹配优势", "岗位链接"];
  const rows = entries.map((entry) => {
    const archive = findMatchingArchive(entry, applicationArchives);
    return [
      entry.company, entry.jobTitle, decodeBossText(entry.expectedSalary), archive?.platform || "",
      archive?.score ?? "", archive?.appliedAt || entry.addedAt || "", cleanStoredDescription(archive?.description || ""),
      (archive?.matchedStrengths || []).join("；"), archive?.url || ""
    ];
  });
  const csv = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `投递白名单_${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus(`已导出 ${rows.length} 条白名单记录`);
}

function readWhitelistRows() {
  return [...document.querySelectorAll("#whitelistRows tr")].map((row) => ({
    id: row.dataset.id,
    company: row.querySelector("[data-field='company']").value.trim(),
    jobTitle: row.querySelector("[data-field='jobTitle']").value.trim(),
    expectedSalary: row.querySelector("[data-field='expectedSalary']").value.trim(),
    addedAt: row.dataset.addedAt
  })).filter((entry) => entry.company && entry.jobTitle);
}

function csvCell(value) {
  const text = String(value ?? "").replace(/"/g, '""');
  return `"${text}"`;
}

function cleanStoredDescription(value) {
  const lines = String(value || "").replace(/\r/g, "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const noise = /^(?:举报|微信扫码分享|扫码分享|分享至微信|分享|收藏|职位发布者|职位发布于|安全提示|求职安全提示|温馨提示)$/;
  while (lines.length && (noise.test(lines[0]) || /^(?:举报|微信扫码|扫码分享)/.test(lines[0]))) lines.shift();
  const firstContent = lines.findIndex((line) => /职位描述|岗位职责|工作职责|任职要求|岗位要求|工作内容|职位要求/.test(line));
  return (firstContent > 0 ? lines.slice(firstContent) : lines).filter((line) => !noise.test(line)).join("\n").trim();
}

function findMatchingArchive(entry, archives) {
  const normalize = (value) => String(value || "").toLowerCase().replace(/[\s·•()（）【】\[\]_-]/g, "");
  return archives.find((archive) => normalize(archive.company) === normalize(entry.company) && normalize(archive.jobTitle) === normalize(entry.jobTitle));
}

const BASE_TERMS = [
  "数据分析", "数据开发", "数据仓库", "数据治理", "数据建模", "维度建模", "指标体系", "数据质量",
  "商业分析", "经营分析", "行业研究", "市场调研", "用户分析", "用户画像", "风险分析", "财务分析",
  "需求分析", "业务分析", "产品分析", "策略分析", "增长分析", "异常分析", "归因分析", "趋势分析",
  "数据清洗", "数据采集", "数据处理", "数据可视化", "报表开发", "看板", "自动化", "监控", "预警",
  "ETL", "SQL", "Python", "Java", "Spark", "Hadoop", "Hive", "Flink", "Kettle", "Pandas", "NumPy",
  "Power BI", "Tableau", "FineReport", "SmartBI", "Excel", "MySQL", "Oracle", "ClickHouse",
  "DWD", "DWS", "ODS", "RFM", "A/B实验", "机器学习", "深度学习", "大模型", "智能体", "LangChain",
  "项目管理", "团队管理", "跨部门协同", "客户沟通", "方案设计", "技术文档", "业务洞察", "决策支持",
  "零售", "电商", "建筑", "金融", "制造", "通信", "物流", "人力资源", "互联网", "供应链"
];

function renderWhitelistWordClouds(whitelist, archives) {
  wordCloudSnapshot = { whitelist, archives };
  const matchedArchives = whitelist.map((entry) => findMatchingArchive(entry, archives)).filter(Boolean);
  const combinedWords = collectCombinedWords(whitelist, matchedArchives);
  drawWordCloud(document.getElementById("combinedWordCloud"), combinedWords);
  document.getElementById("combinedWordCloudEmpty").style.display = combinedWords.length ? "none" : "block";
}

function collectCombinedWords(whitelist, archives) {
  const counts = new Map();
  for (const entry of whitelist) {
    const title = entry.jobTitle.replace(/[（(].*?[）)]/g, "").replace(/\s+/g, " ").trim();
    if (title.length >= 2 && title.length <= 24) addSlicedWord(counts, title, 8, "job");
    for (const term of BASE_TERMS) if (containsTerm(title, term)) addSlicedWord(counts, term, 4, "job");
  }
  for (const archive of archives) {
    const text = `${archive.jobTitle || ""} ${archive.description || ""}`;
    for (const term of BASE_TERMS) {
      const matches = text.toLowerCase().match(new RegExp(escapeRegExp(term.toLowerCase()), "g"));
      if (matches?.length) addSlicedWord(counts, term, matches.length * 3, "jd");
    }
    for (const token of text.match(/[A-Za-z][A-Za-z0-9+#.]{1,20}/g) || []) {
      if (!/^(and|or|the|to|of|in|for|with|app|word|office)$/i.test(token)) addSlicedWord(counts, token, 2, "jd");
    }
    extractChinesePhrases(text).forEach((phrase) => addSlicedWord(counts, phrase, 1, "jd"));
  }
  return [...counts.values()]
    .filter((item) => item.count >= 2 || item.source === "job")
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word, "zh-CN"))
    .slice(0, 90);
}

function addSlicedWord(counts, word, amount, source) {
  const normalized = word.trim();
  if (!normalized) return;
  const key = normalized.toLowerCase();
  const current = counts.get(key) || { word: normalized, count: 0, jobWeight: 0, jdWeight: 0, source };
  current.count += amount;
  if (source === "job") current.jobWeight += amount;
  else current.jdWeight += amount;
  current.source = current.jobWeight >= current.jdWeight ? "job" : "jd";
  counts.set(key, current);
}

function extractChinesePhrases(text) {
  const stop = /负责|要求|相关|工作|岗位|任职|优先|以上|进行|完成|具备|熟悉|使用|能够|包括|不限|以及|通过|公司|我们|具有|良好|一定|根据|提供|参与|协助|日常|其他|内容|能力|经验|专业/;
  const edge = /^[的了和及与对将为在从等各本其该]|[的了和及与为等者中上]$/;
  const phrases = [];
  const segments = String(text || "").match(/[\u4e00-\u9fff]{4,40}/g) || [];
  for (const segment of segments) {
    for (const length of [2, 3, 4]) {
      for (let index = 0; index <= segment.length - length; index += 1) {
        const phrase = segment.slice(index, index + length);
        if (!stop.test(phrase) && !edge.test(phrase)) phrases.push(phrase);
      }
    }
  }
  return phrases;
}

function collectJobWords(whitelist) {
  const counts = new Map();
  for (const entry of whitelist) {
    const title = entry.jobTitle.replace(/[（(].*?[）)]/g, "").replace(/\s+/g, " ").trim();
    if (title.length >= 2 && title.length <= 24) addWordCount(counts, title, 3);
    for (const term of BASE_TERMS) if (containsTerm(title, term)) addWordCount(counts, term, 1);
  }
  return frequencyEntries(counts, 45);
}

function collectBaseWords(archives) {
  const counts = new Map();
  for (const archive of archives) {
    const text = `${archive.jobTitle || ""} ${archive.description || ""}`;
    for (const term of BASE_TERMS) {
      const matches = text.toLowerCase().match(new RegExp(escapeRegExp(term.toLowerCase()), "g"));
      if (matches?.length) addWordCount(counts, term, matches.length);
    }
    for (const token of text.match(/[A-Za-z][A-Za-z0-9+#.]{1,20}/g) || []) {
      if (!/^(and|or|the|to|of|in|for|with|app)$/i.test(token)) addWordCount(counts, token, 1);
    }
  }
  return frequencyEntries(counts, 55);
}

function addWordCount(counts, word, amount) {
  const key = word.toLowerCase();
  const current = counts.get(key) || { word, count: 0 };
  current.count += amount;
  counts.set(key, current);
}

function frequencyEntries(counts, limit) {
  return [...counts.values()].sort((a, b) => b.count - a.count || a.word.localeCompare(b.word, "zh-CN")).slice(0, limit);
}

function containsTerm(text, term) {
  return text.toLowerCase().includes(term.toLowerCase());
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function drawWordCloud(canvas, entries) {
  const width = Math.max(280, Math.round(canvas.clientWidth || 400));
  const height = 340;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const context = canvas.getContext("2d");
  context.scale(ratio, ratio);
  context.clearRect(0, 0, width, height);
  if (!entries.length) return;
  const max = entries[0].count;
  const min = entries[entries.length - 1].count;
  const jobColors = ["#315fa8", "#007f80", "#69528f"];
  const jdColors = ["#a34236", "#3e7652", "#596a6e"];
  const placed = [];
  entries.forEach((entry, index) => {
    const scale = max === min ? 0.55 : (entry.count - min) / (max - min);
    const fontSize = Math.round(11 + Math.sqrt(scale) * 31);
    context.font = `500 ${fontSize}px Inter, Microsoft YaHei, sans-serif`;
    const textWidth = context.measureText(entry.word).width;
    const boxWidth = textWidth + 8;
    const boxHeight = fontSize + 7;
    for (let step = 0; step < 1800; step += 1) {
      const angle = step * 0.42 + index * 0.8;
      const radius = 2.4 * Math.sqrt(step);
      const x = width / 2 + Math.cos(angle) * radius;
      const y = height / 2 + Math.sin(angle) * radius * 0.72;
      const box = { left: x - boxWidth / 2, right: x + boxWidth / 2, top: y - boxHeight / 2, bottom: y + boxHeight / 2 };
      if (box.left < 5 || box.right > width - 5 || box.top < 5 || box.bottom > height - 5) continue;
      if (placed.some((item) => boxesOverlap(box, item))) continue;
      const colors = entry.source === "job" ? jobColors : jdColors;
      context.fillStyle = colors[index % colors.length];
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(entry.word, x, y);
      placed.push(box);
      break;
    }
  });
}

function boxesOverlap(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function scheduleWordCloudRefresh() {
  clearTimeout(wordCloudRefreshTimer);
  wordCloudRefreshTimer = setTimeout(async () => {
    const { applicationArchives = [] } = await chrome.storage.local.get("applicationArchives");
    renderWhitelistWordClouds(readWhitelistRows(), applicationArchives);
  }, 250);
}

window.addEventListener("resize", () => renderWhitelistWordClouds(wordCloudSnapshot.whitelist, wordCloudSnapshot.archives));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.applicationWhitelist && !whitelistDirty) {
    renderWhitelist(changes.applicationWhitelist.newValue || []);
  }
  if (changes.applicationWhitelist || changes.applicationArchives) scheduleWordCloudRefresh();
});

async function toggleOptionsPanel(contentId, buttonId) {
  const content = document.getElementById(contentId);
  const button = document.getElementById(buttonId);
  const collapsed = !content.classList.contains("is-collapsed");
  content.classList.toggle("is-collapsed", collapsed);
  button.textContent = collapsed ? "展开" : "收起";
  button.setAttribute("aria-expanded", String(!collapsed));
  const { optionsPanelState = {} } = await chrome.storage.local.get("optionsPanelState");
  optionsPanelState[contentId] = collapsed;
  await chrome.storage.local.set({ optionsPanelState });
}

async function restoreOptionsPanels() {
  const { optionsPanelState = {} } = await chrome.storage.local.get("optionsPanelState");
  for (const [contentId, buttonId] of [["whitelistContent", "toggleWhitelist"], ["chatKnowledgeContent", "toggleChatKnowledge"]]) {
    const collapsed = Boolean(optionsPanelState[contentId]);
    document.getElementById(contentId).classList.toggle("is-collapsed", collapsed);
    document.getElementById(buttonId).textContent = collapsed ? "展开" : "收起";
    document.getElementById(buttonId).setAttribute("aria-expanded", String(!collapsed));
  }
}

function filterWhitelistRows() {
  const keyword = document.getElementById("whitelistCompanySearch").value.trim().toLowerCase();
  document.querySelectorAll("#whitelistRows tr").forEach((row) => {
    const company = row.querySelector("[data-field='company']").value.toLowerCase();
    row.classList.toggle("is-filtered-out", Boolean(keyword && !company.includes(keyword)));
  });
}

function filterChatKnowledgeRows() {
  const keyword = document.getElementById("chatKnowledgeSearch").value.trim().toLowerCase();
  document.querySelectorAll("#chatKnowledgeRows .knowledge-row").forEach((row) => {
    const text = `${row.querySelector("[data-field='question']").value} ${row.querySelector("[data-field='answer']").value}`.toLowerCase();
    row.classList.toggle("is-filtered-out", Boolean(keyword && !text.includes(keyword)));
  });
}

async function save(showMessage = true) {
  const settings = {
    apiBaseUrl: ui.apiBaseUrl.value.trim().replace(/\/$/, ""),
    apiKey: ui.apiKey.value.trim(),
    model: ui.model.value,
    availableModels: [...ui.model.options].map((option) => option.value).filter(Boolean),
    minimumScore: clampNumber(ui.minimumScore.value, 0, 100, 70),
    searchKeywordCount: clampNumber(ui.searchKeywordCount.value, 8, 30, 16),
    precomputedSearchKeywords: splitList(ui.precomputedSearchKeywords.value),
    precomputedSearchSlices: (settingsCache.precomputedSearchSlices || []).filter((slice) => splitList(ui.precomputedSearchKeywords.value).includes(slice.keyword)),
    greetingMaxLength: clampNumber(ui.greetingMaxLength.value, 50, 500, 180),
    autoSend: ui.autoSend.checked,
    role: "candidate",
    autoApplyIntervalSeconds: clampNumber(ui.autoApplyIntervalSeconds.value, 5, 300, 8),
    chatReplyIntervalSeconds: clampNumber(ui.chatReplyIntervalSeconds.value, 3, 300, 8),
    chatAutoSend: ui.chatAutoSend.checked,
    chatSendResume: ui.chatSendResume.checked,
    profile: {
      resumeText: ui.resumeText.value.trim(),
      strengths: ui.strengths.value.trim(),
      targetRoles: splitList(ui.targetRoles.value),
      targetCities: splitList(ui.targetCities.value),
      minimumSalaryK: clampNumber(ui.minimumSalaryK.value, 0, 1000, 0),
      excludedKeywords: splitList(ui.excludedKeywords.value)
    }
  };
  if (!settings.apiBaseUrl || !settings.model) {
    setStatus("接口地址和模型不能为空", true);
    return false;
  }
  await chrome.storage.local.set({ settings });
  settingsCache = settings;
  if (showMessage) setStatus("已保存");
  return true;
}

async function generateAndSaveSearchKeywords() {
  const button = document.getElementById("generateSearchKeywords");
  button.disabled = true;
  ui.searchKeywordStatus.textContent = "正在根据当前简历生成岗位切片...";
  ui.searchKeywordStatus.style.color = "#627276";
  try {
    const saved = await save(false);
    if (!saved) throw new Error("请先完成接口和简历设置");
    const profileOverride = {
      resumeText: ui.resumeText.value.trim(),
      strengths: ui.strengths.value.trim(),
      targetRoles: splitList(ui.targetRoles.value),
      targetCities: splitList(ui.targetCities.value),
      minimumSalaryK: clampNumber(ui.minimumSalaryK.value, 0, 1000, 0),
      excludedKeywords: splitList(ui.excludedKeywords.value)
    };
    const response = await chrome.runtime.sendMessage({
      type: "GENERATE_SEARCH_KEYWORDS",
      currentRole: "",
      profileOverride,
      keywordCountOverride: clampNumber(ui.searchKeywordCount.value, 8, 30, 16)
    });
    if (!response?.ok || !response.keywords?.length) throw new Error(response?.error || "未生成岗位切片");
    ui.precomputedSearchKeywords.value = response.keywords.join("\n");
    const { settings = {} } = await chrome.storage.local.get("settings");
    const updated = { ...settings, precomputedSearchKeywords: response.keywords, precomputedSearchSlices: response.slices || [] };
    await chrome.storage.local.set({ settings: updated });
    settingsCache = updated;
    ui.searchKeywordStatus.textContent = `已生成并保存 ${response.keywords.length} 个岗位切片，自动投递将直接使用。`;
    ui.searchKeywordStatus.style.color = "#277779";
  } catch (error) {
    ui.searchKeywordStatus.textContent = error.message;
    ui.searchKeywordStatus.style.color = "#b23b2f";
  } finally {
    button.disabled = false;
  }
}

document.getElementById("addChatKnowledge").addEventListener("click", () => appendChatKnowledgeRow({}));
document.getElementById("saveChatKnowledge").addEventListener("click", saveChatKnowledge);
document.getElementById("generateChatKnowledge").addEventListener("click", generateChatKnowledge);

function renderChatKnowledge(entries) {
  const container = document.getElementById("chatKnowledgeRows");
  container.replaceChildren();
  entries.forEach(appendChatKnowledgeRow);
  updateChatKnowledgeEmpty();
}

function appendChatKnowledgeRow(entry = {}) {
  const row = document.createElement("div");
  row.className = "knowledge-row";
  row.dataset.id = entry.id || crypto.randomUUID();
  const question = document.createElement("input");
  question.dataset.field = "question";
  question.placeholder = "例如：你是否做过智能体开发？";
  question.value = entry.question || "";
  const answer = document.createElement("textarea");
  answer.dataset.field = "answer";
  answer.placeholder = "基于真实经历写标准回答";
  answer.rows = 3;
  answer.value = entry.answer || "";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "secondary";
  remove.textContent = "删除";
  remove.addEventListener("click", () => { row.remove(); updateChatKnowledgeEmpty(); });
  row.append(question, answer, remove);
  document.getElementById("chatKnowledgeRows").append(row);
  updateChatKnowledgeEmpty();
}

async function saveChatKnowledge() {
  const chatKnowledge = [...document.querySelectorAll("#chatKnowledgeRows .knowledge-row")].map((row) => ({
    id: row.dataset.id || crypto.randomUUID(),
    question: row.querySelector("[data-field='question']").value.trim(),
    answer: row.querySelector("[data-field='answer']").value.trim()
  })).filter((item) => item.question && item.answer);
  await chrome.storage.local.set({ chatKnowledge });
  renderChatKnowledge(chatKnowledge);
  setStatus(`沟通知识库已保存，共 ${chatKnowledge.length} 条`);
}

function updateChatKnowledgeEmpty() {
  document.getElementById("chatKnowledgeEmpty").style.display = document.querySelectorAll("#chatKnowledgeRows .knowledge-row").length ? "none" : "block";
}

async function generateChatKnowledge() {
  const button = document.getElementById("generateChatKnowledge");
  button.disabled = true;
  setStatus("正在根据简历生成沟通问答...");
  try {
    const response = await chrome.runtime.sendMessage({ type: "GENERATE_CHAT_KNOWLEDGE" });
    if (!response?.ok) throw new Error(response?.error || "生成失败");
    renderChatKnowledge(response.items);
    setStatus(`已生成 ${response.items.length} 条草稿，请检查后保存`);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function testConnection() {
  const button = document.getElementById("testConnection");
  button.disabled = true;
  ui.connectionStatus.textContent = "正在连接...";
  ui.connectionStatus.style.color = "#627276";
  try {
    const response = await chrome.runtime.sendMessage({
      type: "TEST_API",
      config: { apiBaseUrl: ui.apiBaseUrl.value.trim(), apiKey: ui.apiKey.value.trim() }
    });
    if (!response?.ok) throw new Error(response?.error || "连接验证失败");
    setModelOptions(response.models, ui.model.value);
    ui.connectionStatus.textContent = `连接成功，获取到 ${response.models.length} 个模型`;
    ui.connectionStatus.style.color = "#277779";
  } catch (error) {
    setModelOptions([], "");
    ui.connectionStatus.textContent = error.message;
    ui.connectionStatus.style.color = "#b23b2f";
  } finally {
    button.disabled = false;
  }
}

function setModelOptions(models, selected) {
  const values = [...new Set(models)];
  if (selected && !values.includes(selected)) values.unshift(selected);
  ui.model.replaceChildren(...(values.length ? values : [""]).map((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value || "请先验证连接";
    return option;
  }));
  ui.model.disabled = values.length === 0;
  if (selected && values.includes(selected)) ui.model.value = selected;
}

function invalidateConnection() {
  setModelOptions([], "");
  ui.connectionStatus.textContent = "接口信息已变化，请重新验证";
  ui.connectionStatus.style.color = "#8a6626";
}

async function clearHistory() {
  if (!confirm("确认清空所有岗位处理历史？")) return;
  await chrome.storage.local.set({ history: {} });
  renderHistory({});
  setStatus("历史已清空");
}

function splitList(value) {
  return [...new Set(value.split(/[,，;；\n]/).map((item) => item.trim()).filter(Boolean))];
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function renderHistory(history) {
  const entries = Object.values(history);
  const counts = entries.reduce((result, item) => {
    result[item.status] = (result[item.status] || 0) + 1;
    return result;
  }, {});
  ui.historySummary.textContent = `共 ${entries.length} 个岗位；已发送 ${counts.sent || 0}，已填入 ${counts.filled || 0}，已跳过 ${counts.skipped || 0}。`;
}

function setStatus(message, error = false) {
  ui.status.textContent = message;
  ui.status.style.color = error ? "#b23b2f" : "#277779";
  setTimeout(() => { if (ui.status.textContent === message) ui.status.textContent = ""; }, 2500);
}
