const DEFAULTS = {
  settings: {
    apiBaseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4.1-mini",
    profile: {
      resumeText: "",
      targetRoles: [],
      targetCities: [],
      minimumSalaryK: 0,
      excludedKeywords: ["外包"],
      strengths: ""
    },
    minimumScore: 70,
    searchKeywordCount: 16,
    chatAutoSend: false,
    chatSendResume: true,
    chatReplyIntervalSeconds: 8,
    greetingMaxLength: 180,
    autoSend: false,
    role: "candidate",
    autoApplyIntervalSeconds: 8
  },
  history: {}
};
const analysisControllers = new Map();

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(["settings", "history"]);
  await chrome.storage.local.set({
    settings: mergeSettings(DEFAULTS.settings, current.settings),
    history: current.history || DEFAULTS.history
  });
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "ANALYZE_JOB") {
    analyzeJob(message.job, message.runId)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "CANCEL_AUTO_RUN") {
    const controller = analysisControllers.get(message.runId);
    if (controller) controller.abort();
    sendResponse({ ok: true });
    return;
  }
  if (message?.type === "REQUEST_STOP_AUTO_RUN") {
    requestStopActiveRun()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "SCHEDULE_AUTO_APPLY") {
    scheduleAutoApply(message.when)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "CANCEL_SCHEDULED_AUTO_APPLY") {
    cancelScheduledAutoApply()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "TEST_API") {
    testApiConnection(message.config)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "SAVE_HISTORY") {
    saveHistory(message.entry)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "STAGE_APPLICATION_RECORD") {
    stageApplicationRecord(message.record)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "FINALIZE_APPLICATION_RECORD") {
    finalizeApplicationRecord(message.record)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "CLEAR_STAGED_APPLICATION") {
    clearStagedApplication(message.jobId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "GENERATE_SEARCH_KEYWORDS") {
    generateSearchKeywords(message.currentRole, message.profileOverride, message.keywordCountOverride)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "GENERATE_CHAT_REPLY") {
    generateChatReply(message.context)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "GENERATE_CHAT_KNOWLEDGE") {
    generateChatKnowledge()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "COMPLETE_GREETING_FLOW") {
    completeGreetingFlow(message.jobId, message.status)
      .then(async () => {
        if (message.closeTab && sender.tab?.id) {
          const tabIds = [...new Set([sender.tab.id, message.closeTabId].filter(Number.isInteger))];
          await chrome.tabs.remove(tabIds).catch(() => {});
        }
        sendResponse({ ok: true });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
});

async function generateSearchKeywords(currentRole = "", profileOverride = null, keywordCountOverride = null) {
  const { settings: stored } = await chrome.storage.local.get("settings");
  const settings = mergeSettings(DEFAULTS.settings, stored);
  if (profileOverride) settings.profile = { ...settings.profile, ...profileOverride };
  validateSettings(settings);
  const keywordCount = Math.max(8, Math.min(30, Number(keywordCountOverride ?? settings.searchKeywordCount) || 16));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  let response;
  try {
    response = await fetchWithRetry(`${settings.apiBaseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({
      model: settings.model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `你是严谨的求职岗位切片助手。只能依据候选人的真实简历证据，生成 ${keywordCount} 个适合在 BOSS 直聘逐个搜索的中文岗位名称。\n\n请分别从以下维度切片，但某个维度没有简历证据时不得强行生成：\n1. 核心目标岗位及行业通用同义岗位；\n2. 简历中实际承担过的职责对应岗位；\n3. 有项目或成果证明的技术栈对应岗位；\n4. 有真实经验的业务领域岗位；\n5. 可迁移能力对应的相邻岗位。\n\n质量要求：\n- 每个 keyword 必须是招聘网站常见岗位名称，2-12 个汉字或常用中英文组合；\n- 不含城市、薪资、公司、工作年限，不生成“专员/助理/运营”等宽泛词，除非简历明确支持；\n- 不得因为简历提到一次工具名，就推导成缺乏职责或项目证据的岗位；\n- 合并同义、大小写和仅后缀不同的重复词；\n- 按简历匹配度从高到低排序；\n- evidence 必须引用简历中的具体技能、职责、项目或成果，不能写空泛理由；\n- confidence 为 0-100，低于 65 的切片不要返回。\n\n只返回 JSON：{"slices":[{"keyword":"数据分析师","dimension":"核心岗位","evidence":"简历中的具体证据","confidence":92}]}`
        },
        { role: "user", content: JSON.stringify({ profile: settings.profile, currentRole, requestedCount: keywordCount }) }
      ]
      })
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("生成岗位切片超过 45 秒，请检查 AI 接口或网络");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new Error(`生成搜索关键词失败 (${response.status})`);
  const payload = await response.json();
  const value = JSON.parse(payload.choices?.[0]?.message?.content || "{}");
  const cleanedCurrentRole = String(currentRole).replace(/[（(](?:北京|上海|天津|重庆|深圳|广州|杭州|成都|武汉|西安|南京|苏州|长沙|郑州|青岛|厦门|合肥|昆明|宁波|东莞)[）)]/g, "").trim();
  const rawSlices = Array.isArray(value.slices)
    ? value.slices
    : (Array.isArray(value.keywords) ? value.keywords.map((keyword) => ({ keyword, dimension: "兼容结果", evidence: "" })) : []);
  const sliceMap = new Map();
  for (const item of rawSlices) {
    const keyword = String(item?.keyword || "").trim();
    const identity = normalizeSearchKeyword(keyword);
    const confidence = Math.max(0, Math.min(100, Number(item?.confidence) || 0));
    if (!identity || keyword.length < 2 || keyword.length > 20 || (item?.confidence != null && confidence < 65)) continue;
    if (!sliceMap.has(identity)) {
      sliceMap.set(identity, {
        keyword,
        dimension: String(item?.dimension || "简历切片"),
        evidence: String(item?.evidence || "").slice(0, 240),
        confidence: item?.confidence == null ? null : confidence
      });
    }
  }
  const fallbacks = [...(settings.profile.targetRoles || []), cleanedCurrentRole].filter(Boolean);
  for (const keyword of fallbacks) {
    const identity = normalizeSearchKeyword(keyword);
    if (identity && !sliceMap.has(identity)) {
      sliceMap.set(identity, { keyword: String(keyword).trim(), dimension: "用户目标岗位", evidence: "来自插件中设置的目标岗位", confidence: 100 });
    }
  }
  const priorityIdentities = new Set(fallbacks.map(normalizeSearchKeyword).filter(Boolean));
  const slices = [...sliceMap.values()]
    .sort((a, b) => Number(priorityIdentities.has(normalizeSearchKeyword(b.keyword))) - Number(priorityIdentities.has(normalizeSearchKeyword(a.keyword))))
    .slice(0, keywordCount);
  const keywords = slices.map((item) => item.keyword);
  if (!keywords.length) throw new Error("未能从简历和目标岗位生成搜索关键词");
  return { ok: true, keywords, slices };
}

function normalizeSearchKeyword(value) {
  return String(value || "").toLowerCase().replace(/[\s·•()（）【】\[\]_-]/g, "").replace(/(工程师|专员|岗位)$/g, "");
}

async function generateChatReply(context = {}) {
  const { settings: stored, applicationArchives = [], chatKnowledge = [] } = await chrome.storage.local.get([
    "settings", "applicationArchives", "chatKnowledge"
  ]);
  const settings = mergeSettings(DEFAULTS.settings, stored);
  validateSettings(settings);
  const query = `${context.jobTitle || ""} ${context.company || ""} ${context.latestIncoming || ""}`;
  const chunks = buildChatKnowledgeChunks(settings.profile, applicationArchives, chatKnowledge, context);
  const retrieved = retrieveKnowledge(query, chunks, 10);
  const response = await fetchWithRetry(`${settings.apiBaseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.apiKey}` },
    body: JSON.stringify({
      model: settings.model,
      temperature: 0.15,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `你是候选人的招聘沟通助手，只能使用检索证据和真实聊天内容回复，不得虚构项目、年限、技术能力、学历或成果。回复应自然、具体、简洁，通常 60-180 个中文字符。\n\n处理策略：\n1. 对“是否做过XX、技术栈、项目介绍、对XX的看法”等问题，先直接回答结论，再给真实证据和与岗位的联系。\n2. context.followUpMode=true 表示候选人的上一条消息已读超过 48 小时，只能发送一次简短、有新增价值的跟进，不重复原招呼，不施压；没有新增岗位匹配证据时 action=no_reply。\n3. 对“不太合适/暂不考虑”等拒绝，只有检索证据能直接回应对方顾虑时，允许一次克制挽回；否则礼貌感谢并结束，action=close。\n4. 不追问薪资、微信、电话等敏感信息；不承诺无法确认的到岗时间。\n5. sendResume 仅在 HR 明确索要简历/附件，或对方明确进入面试、经验核实、进一步了解阶段且未拒绝时为 true。\n6. 如果只是系统通知、表情、无实质内容或不需要回复，action=no_reply。\n\n只返回 JSON：{"action":"reply|close|no_reply","reply":"回复文本","questionType":"experience|tech_stack|opinion|availability|follow_up|rejection|other","sendResume":false,"confidence":0-100,"rationale":"使用了哪些证据"}`
        },
        { role: "user", content: JSON.stringify({ context, retrievedEvidence: retrieved }) }
      ]
    })
  });
  if (!response.ok) throw new Error(`生成聊天回复失败 (${response.status})`);
  const payload = await response.json();
  const value = JSON.parse(payload.choices?.[0]?.message?.content || "{}");
  const action = ["reply", "close", "no_reply"].includes(value.action) ? value.action : "no_reply";
  const rejected = /不太合适|不合适|暂不考虑|不匹配|谢谢关注/.test(context.latestIncoming || "");
  const resumeRequested = /(?:发|发送|提供|看下|看一下).{0,6}(?:简历|附件)|简历.{0,6}(?:发|提供)/.test(context.latestIncoming || "");
  const positiveStage = /面试|进一步了解|详细聊|工作经历|项目经历|方便沟通|到岗/.test(context.latestIncoming || "");
  return {
    ok: true,
    result: {
      action,
      reply: String(value.reply || "").trim().slice(0, 500),
      questionType: String(value.questionType || "other"),
      sendResume: Boolean(settings.chatSendResume && value.sendResume && !rejected && (resumeRequested || positiveStage)),
      confidence: Math.max(0, Math.min(100, Number(value.confidence) || 0)),
      rationale: String(value.rationale || ""),
      retrieved
    }
  };
}

function buildChatKnowledgeChunks(profile, archives, knowledge, context) {
  const chunks = [];
  if (profile.resumeText) chunks.push({ source: "简历", text: profile.resumeText });
  if (profile.strengths) chunks.push({ source: "个人优势", text: profile.strengths });
  for (const item of knowledge) {
    if (item.question || item.answer) chunks.push({ source: `热点问答：${item.question || "补充知识"}`, text: item.answer || "" });
  }
  for (const archive of archives) {
    const sameJob = normalizeArchiveText(archive.company) === normalizeArchiveText(context.company)
      && normalizeArchiveText(archive.jobTitle) === normalizeArchiveText(context.jobTitle);
    if (sameJob) chunks.push({ source: "当前投递岗位档案", text: JSON.stringify(archive) });
  }
  return chunks.flatMap((chunk) => splitKnowledgeChunk(chunk));
}

function splitKnowledgeChunk(chunk) {
  const text = String(chunk.text || "").replace(/\s+/g, " ").trim();
  if (!text) return [];
  const result = [];
  for (let index = 0; index < text.length; index += 420) {
    result.push({ source: chunk.source, text: text.slice(index, index + 520) });
  }
  return result;
}

function retrieveKnowledge(query, chunks, limit) {
  const terms = [...new Set(String(query).toLowerCase().match(/[a-z0-9+#.]+|[\u4e00-\u9fff]{2,6}/g) || [])];
  const ranked = chunks.map((chunk) => ({
    ...chunk,
    score: terms.reduce((score, term) => score + (chunk.text.toLowerCase().includes(term) ? Math.max(1, term.length) : 0), 0)
  })).sort((a, b) => b.score - a.score);
  const matched = ranked.filter((item) => item.score > 0);
  return (matched.length ? matched : ranked).slice(0, limit);
}

function normalizeArchiveText(value) {
  return String(value || "").toLowerCase().replace(/[\s·•()（）【】\[\]_-]/g, "");
}

async function generateChatKnowledge() {
  const { settings: stored } = await chrome.storage.local.get("settings");
  const settings = mergeSettings(DEFAULTS.settings, stored);
  validateSettings(settings);
  const response = await fetchWithRetry(`${settings.apiBaseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.apiKey}` },
    body: JSON.stringify({
      model: settings.model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "根据候选人的真实简历和个人优势，创建 10-16 条招聘沟通热点问答草稿。覆盖：是否做过某类项目、核心技术栈、项目职责、技术难点与解决方案、方案取舍、业务理解、岗位看法、个人优势、短板与学习计划、到岗与职业方向。不得虚构年限、项目、成果或工具。问题要像 HR 的自然提问；回答先给结论，再给具体证据，80-220 个中文字符。没有证据的问题不要生成。只返回 JSON：{\"items\":[{\"question\":\"...\",\"answer\":\"...\"}]}"
        },
        { role: "user", content: JSON.stringify(settings.profile) }
      ]
    })
  });
  if (!response.ok) throw new Error(`生成沟通知识库失败 (${response.status})`);
  const payload = await response.json();
  const value = JSON.parse(payload.choices?.[0]?.message?.content || "{}");
  const items = (Array.isArray(value.items) ? value.items : []).map((item) => ({
    id: crypto.randomUUID(),
    question: String(item.question || "").trim().slice(0, 160),
    answer: String(item.answer || "").trim().slice(0, 600)
  })).filter((item) => item.question && item.answer).slice(0, 16);
  if (!items.length) throw new Error("未能从简历生成有证据的沟通问答");
  return { ok: true, items };
}

async function testApiConnection(config = {}) {
  const apiBaseUrl = String(config.apiBaseUrl || "").trim().replace(/\/$/, "");
  const apiKey = String(config.apiKey || "").trim();
  if (!apiBaseUrl || !apiKey) throw new Error("请先填写接口地址和 API Key");

  let parsedUrl;
  try {
    parsedUrl = new URL(apiBaseUrl);
  } catch {
    throw new Error("接口地址格式无效，请填写完整的 http:// 或 https:// 地址");
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error("接口地址仅支持 HTTP 或 HTTPS");

  const response = await fetch(`${apiBaseUrl}/models`, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`连接失败 (${response.status}): ${body.slice(0, 240)}`);
  }
  const payload = await response.json();
  const rawModels = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [];
  const models = rawModels
    .map((item) => typeof item === "string" ? item : item?.id || item?.name)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  if (!models.length) throw new Error("接口已连通，但 /models 没有返回可用模型名称");
  return { ok: true, models };
}

function mergeSettings(defaults, value = {}) {
  return {
    ...defaults,
    ...value,
    profile: { ...defaults.profile, ...(value.profile || {}) }
  };
}

async function analyzeJob(job, runId = null) {
  const { settings: stored } = await chrome.storage.local.get("settings");
  const settings = mergeSettings(DEFAULTS.settings, stored);
  validateSettings(settings);

  const hardFilter = runHardFilters(job, settings.profile);
  if (!hardFilter.passed) {
    return {
      ok: true,
      result: {
        score: 0,
        recommendation: "skip",
        summary: "未通过硬性筛选",
        matchedStrengths: [],
        concerns: hardFilter.reasons,
        greeting: ""
      }
    };
  }

  const controller = new AbortController();
  if (runId) analysisControllers.set(runId, controller);
  let response;
  try {
    response = await fetchWithRetry(`${settings.apiBaseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify({
        model: settings.model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: buildSystemPrompt(settings) },
          { role: "user", content: JSON.stringify({ profile: settings.profile, job }) }
        ]
      }),
      signal: controller.signal
    });
  } finally {
    if (runId && analysisControllers.get(runId) === controller) analysisControllers.delete(runId);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`AI 请求失败 (${response.status}): ${body.slice(0, 240)}`);
  }
  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("AI 没有返回分析内容");
  const result = normalizeAnalysis(JSON.parse(content), settings);
  return { ok: true, result };
}

async function scheduleAutoApply(when) {
  const timestamp = Number(when);
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) throw new Error("定时时间必须晚于当前系统时间");
  await chrome.alarms.create("scheduled-auto-apply", { when: timestamp });
  await chrome.storage.local.set({ scheduledAutoApplyAt: timestamp });
  return { ok: true, when: timestamp };
}

async function cancelScheduledAutoApply() {
  await chrome.alarms.clear("scheduled-auto-apply");
  await chrome.storage.local.remove("scheduledAutoApplyAt");
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "scheduled-auto-apply") return;
  await chrome.storage.local.remove("scheduledAutoApplyAt");
  await chrome.windows.create({
    url: chrome.runtime.getURL("sidepanel.html?scheduled=1"),
    type: "normal",
    focused: false,
    state: "minimized"
  });
});

async function requestStopActiveRun() {
  const { activeAutoRun } = await chrome.storage.local.get("activeAutoRun");
  if (!activeAutoRun?.runId) return { ok: false, error: "当前没有正在运行的自动投递任务" };
  const controller = analysisControllers.get(activeAutoRun.runId);
  if (controller) controller.abort();
  await chrome.runtime.sendMessage({ type: "STOP_AUTO_RUN", runId: activeAutoRun.runId }).catch(() => {});
  await chrome.storage.local.remove("activeAutoRun");
  return { ok: true, runId: activeAutoRun.runId };
}

function validateSettings(settings) {
  if (!settings.apiBaseUrl || !settings.apiKey || !settings.model) {
    throw new Error("请先在设置页填写 AI 接口地址、密钥和模型");
  }
  if (!settings.profile.resumeText.trim()) {
    throw new Error("请先在设置页填写简历内容");
  }
}

function runHardFilters(job, profile) {
  const text = `${job.title} ${job.company} ${job.description}`.toLowerCase();
  const reasons = [];
  const inactiveRecruiterReason = getInactiveRecruiterReason(job.recruiterActivity);
  if (inactiveRecruiterReason) reasons.push(inactiveRecruiterReason);
  for (const keyword of profile.excludedKeywords || []) {
    if (keyword && text.includes(keyword.toLowerCase())) reasons.push(`包含排除词：${keyword}`);
  }
  if (profile.targetCities?.length && job.city && !profile.targetCities.some((city) => job.city.includes(city))) {
    reasons.push(`城市不匹配：${job.city}`);
  }
  if (profile.minimumSalaryK > 0 && job.salaryMinK != null && job.salaryMinK < profile.minimumSalaryK) {
    reasons.push(`最低薪资 ${job.salaryMinK}K 低于期望`);
  }
  return { passed: reasons.length === 0, reasons };
}

function getInactiveRecruiterReason(activity) {
  const value = String(activity || "").replace(/\s+/g, "");
  if (!value) return "";
  if (/(?:很久|长期|半年|一年)(?:未在线|未活跃|未登录|前活跃)/.test(value)) {
    return `招聘者长期不活跃：${value}`;
  }
  const months = value.match(/(\d+)(?:个月|月)(?:前(?:在线|活跃|登录)|未在线|未活跃|未登录)/);
  if (months && Number(months[1]) >= 2) return `招聘者已 ${months[1]} 个月不活跃：${value}`;
  const years = value.match(/(\d+)年(?:前(?:在线|活跃|登录)|未在线|未活跃|未登录)/);
  if (years) return `招聘者已长期不活跃：${value}`;
  const days = value.match(/(\d+)(?:天|日)(?:前(?:在线|活跃|登录)|未在线|未活跃|未登录)/);
  if (days && Number(days[1]) >= 60) return `招聘者已超过 60 天不活跃：${value}`;
  const weeks = value.match(/(\d+)周(?:前(?:在线|活跃|登录)|未在线|未活跃|未登录)/);
  if (weeks && Number(weeks[1]) >= 8) return `招聘者已超过 8 周不活跃：${value}`;
  const reversed = value.match(/(?:在线|活跃|登录)于?(\d+)(个月|月|年)前/);
  if (reversed && (reversed[2] === "年" || Number(reversed[1]) >= 2)) return `招聘者长期不活跃：${value}`;
  return "";
}

function buildSystemPrompt(settings) {
  return `你是应聘者的求职匹配助手，用户是正在求职的候选人，对方是招聘者或 HR。只依据提供的简历和岗位信息判断，绝不虚构经历。返回 JSON，字段必须为：score(0-100整数)、recommendation(apply/caution/skip)、summary(一句话)、matchedStrengths(字符串数组)、concerns(字符串数组)、greeting(中文招呼语)。greeting 必须使用候选人第一人称向招聘者打招呼，表达应聘意向；需要点出岗位需求与候选人真实优势的对应关系，不得写成 HR 邀请候选人面试或介绍职位的口吻。语气自然、不卑不亢，不写“精通”除非简历明确支持，不超过 ${settings.greetingMaxLength} 个汉字。评分低于 ${settings.minimumScore} 时 recommendation 不得为 apply。`;
}

function normalizeAnalysis(value, settings) {
  const score = Math.max(0, Math.min(100, Math.round(Number(value.score) || 0)));
  const allowed = ["apply", "caution", "skip"];
  let recommendation = allowed.includes(value.recommendation) ? value.recommendation : "caution";
  if (score < settings.minimumScore && recommendation === "apply") recommendation = "caution";
  return {
    score,
    recommendation,
    summary: String(value.summary || "暂无摘要"),
    matchedStrengths: toStringArray(value.matchedStrengths),
    concerns: toStringArray(value.concerns),
    greeting: String(value.greeting || "").slice(0, settings.greetingMaxLength)
  };
}

function toStringArray(value) {
  return Array.isArray(value) ? value.map(String).filter(Boolean).slice(0, 8) : [];
}

async function saveHistory(entry) {
  const { history = {} } = await chrome.storage.local.get("history");
  history[entry.jobId] = { ...entry, savedAt: new Date().toISOString() };
  await chrome.storage.local.set({ history });
}

async function completeGreetingFlow(jobId, status) {
  if (!jobId) return;
  const { history = {} } = await chrome.storage.local.get("history");
  history[jobId] = {
    ...(history[jobId] || { jobId }),
    status,
    savedAt: new Date().toISOString()
  };
  await chrome.storage.local.set({ history });
  if (status === "sent") {
    const { pendingApplicationRecords = {} } = await chrome.storage.local.get("pendingApplicationRecords");
    const record = pendingApplicationRecords[jobId];
    if (record) await finalizeApplicationRecord(record);
  }
}

async function stageApplicationRecord(record) {
  if (!record?.job?.jobId) throw new Error("缺少待归档岗位信息");
  const { pendingApplicationRecords = {} } = await chrome.storage.local.get("pendingApplicationRecords");
  pendingApplicationRecords[record.job.jobId] = record;
  await chrome.storage.local.set({ pendingApplicationRecords });
}

async function clearStagedApplication(jobId) {
  if (!jobId) return;
  const { pendingApplicationRecords = {} } = await chrome.storage.local.get("pendingApplicationRecords");
  delete pendingApplicationRecords[jobId];
  await chrome.storage.local.set({ pendingApplicationRecords });
}

async function finalizeApplicationRecord(record) {
  const job = record?.job;
  if (!job?.title || !job?.company) throw new Error("岗位归档缺少企业或岗位名称");
  const result = record.result || {};
  const { applicationWhitelist = [], applicationArchives = [], pendingApplicationRecords = {} } = await chrome.storage.local.get([
    "applicationWhitelist", "applicationArchives", "pendingApplicationRecords"
  ]);
  const matches = (entry) => normalizeArchiveText(entry.company) === normalizeArchiveText(job.company)
    && normalizeArchiveText(entry.jobTitle) === normalizeArchiveText(job.title);
  if (!applicationWhitelist.some(matches)) {
    applicationWhitelist.push({
      id: crypto.randomUUID(), company: job.company, jobTitle: job.title,
      expectedSalary: job.salary || "", addedAt: new Date().toISOString()
    });
  }
  const previousArchive = applicationArchives.find(matches);
  const archive = {
    ...(previousArchive || {}),
    id: previousArchive?.id || crypto.randomUUID(),
    company: job.company,
    jobTitle: job.title,
    salary: job.salary || previousArchive?.salary || "",
    platform: job.platform || previousArchive?.platform || "boss",
    description: String(job.description || previousArchive?.description || "").slice(0, 10000),
    recruiter: job.recruiter || previousArchive?.recruiter || "",
    recruiterActivity: job.recruiterActivity || previousArchive?.recruiterActivity || "",
    score: result.score ?? previousArchive?.score ?? null,
    matchedStrengths: result.matchedStrengths || previousArchive?.matchedStrengths || [],
    greeting: record.greeting || previousArchive?.greeting || "",
    url: job.url || previousArchive?.url || "",
    appliedAt: new Date().toISOString()
  };
  delete pendingApplicationRecords[job.jobId];
  await chrome.storage.local.set({
    applicationWhitelist,
    applicationArchives: [...applicationArchives.filter((item) => !matches(item)), archive].slice(-500),
    pendingApplicationRecords
  });
}

async function fetchWithRetry(url, options, attempts = 2) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetch(url, options);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
  throw lastError;
}
