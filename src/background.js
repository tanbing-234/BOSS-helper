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
    analyzeJob(message.job, message.runId, message.includeGreeting !== false)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "GENERATE_JOB_GREETING") {
    generateJobGreeting(message.job, message.analysis)
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
  if (message?.type === "GENERATE_RAG_TEST_SUITE") {
    generateRagTestSuite()
      .then(sendResponse)
      .catch(async (error) => {
        await updateRagBuildProgress("error", "构建失败", 100, error.message).catch(() => {});
        sendResponse({ ok: false, error: error.message });
      });
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
  const { settings: stored, applicationArchives = [], chatKnowledge = [], ragTestCases = [], resumeKnowledgeBase = null } = await chrome.storage.local.get([
    "settings", "applicationArchives", "chatKnowledge", "ragTestCases", "resumeKnowledgeBase"
  ]);
  const settings = mergeSettings(DEFAULTS.settings, stored);
  validateSettings(settings);
  const query = `${context.jobTitle || ""} ${context.company || ""} ${context.latestIncoming || ""}`;
  const chunks = buildChatKnowledgeChunks(settings.profile, applicationArchives, chatKnowledge, ragTestCases, context, resumeKnowledgeBase);
  const retrieved = retrieveKnowledge(query, chunks, 10);
  const retrievalConfidence = calculateRetrievalConfidence(retrieved);
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
          content: `你是候选人的招聘沟通助手，只能使用检索证据和真实聊天内容回复，不得虚构项目、年限、技术能力、学历或成果。回复应自然、具体、简洁，通常 60-180 个中文字符。\n\n处理策略：\n1. 对“是否做过XX、技术栈、项目介绍、对XX的看法”等问题，先直接回答结论，再给真实证据和与岗位的联系。\n2. 直接经验不足时不要机械拒答，采用“诚实边界 + 已有可迁移能力 + 补齐或适应路径”的候选人口吻。可以说“目前没有直接负责过该场景，但我在XX方面的经验可以迁移”，不得把没有做过说成做过。\n3. 永远不要向招聘者说“知识库没有检索到、简历没有提供、系统无法回答、现有证据不足”等内部处理语言。确实缺少学历、时间等确定事实时，用“这部分我可以进一步如实补充说明”承接，不猜测具体信息。\n4. context.followUpMode=true 表示候选人的上一条消息已读超过 48 小时，只能发送一次简短、有新增价值的跟进，不重复原招呼，不施压；没有新增岗位匹配证据时 action=no_reply。\n5. 对“不太合适/暂不考虑”等拒绝，只有检索证据能直接回应对方顾虑时，允许一次克制挽回；否则礼貌感谢并结束，action=close。\n6. 不追问薪资、微信、电话等敏感信息；不承诺无法确认的到岗时间。\n7. sendResume 仅在 HR 明确索要简历/附件，或对方明确进入面试、经验核实、进一步了解阶段且未拒绝时为 true。\n8. 如果只是系统通知、表情、无实质内容或不需要回复，action=no_reply。\n\n只返回 JSON：{"action":"reply|close|no_reply","reply":"回复文本","questionType":"experience|tech_stack|opinion|availability|follow_up|rejection|other","sendResume":false,"confidence":0-100,"rationale":"使用了哪些证据"}`
        },
        { role: "user", content: JSON.stringify({ context, retrievalConfidence, retrievedEvidence: retrieved }) }
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
  const finalConfidence = Math.min(Math.max(0, Math.min(100, Number(value.confidence) || 0)), retrievalConfidence || 35);
  const recruiterFacingReply = rewriteBoundaryAnswer(context.latestIncoming || "", String(value.reply || "").trim());
  if (context.latestIncoming) {
    await recordRagObservation({
      context,
      query,
      retrieved,
      retrievalConfidence,
      agentConfidence: Number(value.confidence) || 0,
      action,
      answer: recruiterFacingReply
    });
  }
  return {
    ok: true,
    result: {
      action,
      reply: recruiterFacingReply.slice(0, 500),
      questionType: String(value.questionType || "other"),
      sendResume: Boolean(settings.chatSendResume && value.sendResume && !rejected && (resumeRequested || positiveStage)),
      confidence: finalConfidence,
      rationale: String(value.rationale || ""),
      retrieved
    }
  };
}

function buildChatKnowledgeChunks(profile, archives, knowledge, testCases, context, resumeKnowledgeBase = null) {
  const chunks = [];
  const knowledgeIsCurrent = resumeKnowledgeBase?.resumeFingerprint === fingerprintText(profile.resumeText || "");
  for (const evidence of (knowledgeIsCurrent ? resumeKnowledgeBase?.evidenceUnits : []) || []) {
    chunks.push({
      source: `结构化简历证据：${evidence.title || evidence.category || "经历"}`,
      type: "structured_resume",
      question: (evidence.retrievalHints || []).join(" "),
      text: [evidence.category, evidence.title, evidence.context, evidence.role, ...(evidence.skills || []), ...(evidence.actions || []), ...(evidence.outcomes || []), ...(evidence.retrievalHints || []), evidence.evidenceQuote].filter(Boolean).join("\n")
    });
  }
  if (profile.resumeText) chunks.push({ source: "简历", type: "resume", text: profile.resumeText });
  if (profile.strengths) chunks.push({ source: "个人优势", type: "strength", text: profile.strengths });
  for (const item of knowledge) {
    if (item.question || item.answer) chunks.push({ source: `热点问答：${item.question || "补充知识"}`, type: "qa", question: item.question || "", text: `${item.question || ""}\n${item.answer || ""}` });
  }
  for (const item of testCases || []) {
    if (item.source === "production" || !item.question || !item.expectedAnswer || ["no_reply", "close"].includes(item.expectedAction)) continue;
    chunks.push({
      source: `已审核RAG数据：${item.question}`,
      type: "qa",
      question: item.question,
      text: `${item.question}\n${item.expectedAnswer}\n意图：${item.intent || "通用招聘问答"}`
    });
  }
  for (const archive of archives) {
    const sameJob = normalizeArchiveText(archive.company) === normalizeArchiveText(context.company)
      && normalizeArchiveText(archive.jobTitle) === normalizeArchiveText(context.jobTitle);
    if (sameJob) chunks.push({ source: "当前投递岗位档案", type: "job", text: JSON.stringify(archive) });
  }
  return chunks.flatMap((chunk) => splitKnowledgeChunk(chunk));
}

function splitKnowledgeChunk(chunk) {
  const text = String(chunk.text || "").replace(/\s+/g, " ").trim();
  if (!text) return [];
  const result = [];
  for (let index = 0; index < text.length; index += 420) {
    result.push({ source: chunk.source, type: chunk.type || "other", question: chunk.question || "", chunkId: `${chunk.type || "other"}-${index}`, text: text.slice(index, index + 520) });
  }
  return result;
}

function retrieveKnowledge(query, chunks, limit) {
  const terms = [...new Set(String(query).toLowerCase().match(/[a-z0-9+#.]+|[\u4e00-\u9fff]{2,6}/g) || [])];
  const ranked = chunks.map((chunk) => ({
    ...chunk,
    matchedTerms: terms.filter((term) => chunk.text.toLowerCase().includes(term)),
    score: terms.reduce((score, term) => score + (chunk.text.toLowerCase().includes(term) ? Math.max(1, term.length) : 0), 0)
  })).sort((a, b) => b.score - a.score);
  const matched = ranked.filter((item) => item.score > 0);
  return (matched.length ? matched : ranked).slice(0, limit);
}

function calculateRetrievalConfidence(retrieved) {
  if (!retrieved.length || !retrieved[0].score) return 20;
  const top = retrieved[0];
  const sourceBonus = top.type === "qa" ? 18 : top.type === "structured_resume" ? 16 : top.type === "resume" ? 12 : 6;
  return Math.max(20, Math.min(95, 35 + top.score * 3 + (top.matchedTerms?.length || 0) * 4 + sourceBonus));
}

async function recordRagObservation(observation) {
  const { ragObservations = [], ragQuestionInbox = [], ragTestCases = [] } = await chrome.storage.local.get([
    "ragObservations", "ragQuestionInbox", "ragTestCases"
  ]);
  const question = String(observation.context.latestIncoming || "").trim().slice(0, 300);
  const record = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), question, ...observation };
  const nextObservations = [...ragObservations, record].slice(-500);
  const weak = observation.retrievalConfidence < 70 || observation.action === "no_reply";
  const duplicate = ragQuestionInbox.some((item) => normalizeArchiveText(item.question) === normalizeArchiveText(question));
  let nextInbox = ragQuestionInbox;
  if (weak && question && !duplicate) {
    nextInbox = [...ragQuestionInbox, { id: crypto.randomUUID(), question, answer: "", status: "pending", frequency: 1, source: "真实招聘对话", createdAt: record.createdAt }].slice(-200);
  } else if (weak && duplicate) {
    nextInbox = ragQuestionInbox.map((item) => normalizeArchiveText(item.question) === normalizeArchiveText(question)
      ? { ...item, frequency: (item.frequency || 1) + 1 }
      : item);
  }
  const testCase = { id: crypto.randomUUID(), question, expectedAction: observation.action, expectedAnswer: observation.answer, source: "production", createdAt: record.createdAt };
  await chrome.storage.local.set({ ragObservations: nextObservations, ragQuestionInbox: nextInbox, ragTestCases: [...ragTestCases, testCase].slice(-500) });
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

async function generateRagTestSuite() {
  await updateRagBuildProgress("running", "读取数据", 5, "正在读取简历、现有问答和历史测试数据...");
  const { settings: stored, chatKnowledge = [], ragQuestionInbox = [], ragTestCases = [] } = await chrome.storage.local.get([
    "settings", "chatKnowledge", "ragQuestionInbox", "ragTestCases"
  ]);
  const settings = mergeSettings(DEFAULTS.settings, stored);
  validateSettings(settings);
  if (!settings.profile.resumeText?.trim()) throw new Error("请先填写简历全文");

  await updateRagBuildProgress("running", "简历证据建模", 15, "正在识别候选人的经历、职责、技能、成果和证据边界...");
  const knowledgeBase = await callJsonModel(settings, [
    {
      role: "system",
      content: `你是通用招聘简历知识建模器。适用于技术、产品、运营、销售、财务、制造、设计、教育、医疗等任意专业领域。把简历转换为可检索的原子证据单元，不要围绕某个预设职业或AI领域。

要求：
1. 每个证据单元只表达一组紧密相关的事实，并保留项目/公司/岗位上下文。
2. 严格区分：亲自负责、参与协作、学习了解、个人兴趣；不得提升责任级别。
3. 没有原文证据时不得推导年限、结果、技术、行业经验或交付状态。
4. retrievalHints 写招聘者可能使用的同义问法、能力表达和领域术语，用于跨表达检索。
5. evidenceQuote 必须是简历中的短原文或忠实摘录。

只返回 JSON：{"candidateDomains":["领域"],"roleFamilies":["岗位族"],"evidenceUnits":[{"id":"E1","category":"project|responsibility|skill|achievement|domain|education|preference|constraint","title":"标题","context":"背景","role":"候选人的真实角色","skills":["技能"],"actions":["行动"],"outcomes":["结果"],"evidenceLevel":"direct|adjacent|self_reported","retrievalHints":["同义检索表达"],"evidenceQuote":"简历证据"}]}`
    },
    { role: "user", content: JSON.stringify(settings.profile) }
  ], 0.05);
  const evidenceUnits = (Array.isArray(knowledgeBase.evidenceUnits) ? knowledgeBase.evidenceUnits : []).slice(0, 120);
  if (!evidenceUnits.length) throw new Error("未能从简历抽取有效证据");
  knowledgeBase.evidenceUnits = evidenceUnits;
  knowledgeBase.resumeFingerprint = fingerprintText(settings.profile.resumeText);
  knowledgeBase.generatedAt = new Date().toISOString();

  await updateRagBuildProgress("running", "生成测试问题", 45, `已抽取 ${evidenceUnits.length} 条结构化证据，正在生成跨意图招聘问题...`);
  const candidateSuite = await callJsonModel(settings, [
    {
      role: "system",
      content: `你是通用招聘RAG测试集设计器。根据候选人的结构化简历证据生成测试用例，不能假设候选人属于某个固定行业。

覆盖维度：项目经历、职责边界、专业技能、业务/行业理解、成果与难点、能力迁移、岗位匹配疑虑、职业方向、教育背景、没有证据时的安全拒答。问题要像真实招聘者，包含直接问法、口语问法、同义改写、质疑式问法和跨领域迁移问法。

每条 expectedAnswer 必须只引用 evidenceIds 中的事实。对于 partial 或 unanswerable，不得输出“简历没有提供、知识库没有检索到、无法回答、证据不足”等系统语言；应采用面向招聘者的“诚实边界 + 已有可迁移能力 + 学习/适应路径”表达。缺少学历、时间等确定事实时，不猜测具体信息，可以说“这部分我可以进一步如实补充说明”，并自然转向真实优势。此类 expectedAction 使用 reply_with_boundary，不使用机械拒答。只返回 JSON：{"cases":[{"question":"招聘者问题","intent":"project|responsibility|skill|domain|achievement|transferability|fit_gap|career|education|unknown","difficulty":"easy|medium|hard","answerability":"direct|partial|unanswerable","evidenceIds":["E1"],"expectedAction":"reply|reply_with_boundary|no_claim","expectedAnswer":"面向招聘者的参考回答","riskTags":["hallucination|responsibility_inflation|missing_metric|none"]}]}`
    },
    { role: "user", content: JSON.stringify({ knowledgeBase, curatedQuestions: chatKnowledge.map((item) => item.question), observedQuestions: ragQuestionInbox.map((item) => item.question), requestedCount: 30 }) }
  ], 0.15);
  const cases = (Array.isArray(candidateSuite.cases) ? candidateSuite.cases : []).slice(0, 50);
  if (!cases.length) throw new Error("模型未生成测试用例");

  await updateRagBuildProgress("running", "多维独立评估", 72, `已生成 ${cases.length} 条候选用例，正在分批并行评估...`);
  const evaluations = await evaluateRagCasesInBatches(settings, evidenceUnits, cases);
  const now = new Date().toISOString();
  const accepted = cases.map((item, index) => {
    const review = evaluations.find((entry) => Number(entry.index) === index);
    if (!review || review.rejected || Number(review.overall) < 75 || Number(review.groundedness) < 85) return null;
    return {
      id: crypto.randomUUID(), ...item,
      expectedAnswer: rewriteBoundaryAnswer(item.question, String(review.correctedExpectedAnswer || item.expectedAnswer || "").trim()),
      expectedAction: item.answerability === "direct" ? item.expectedAction : "reply_with_boundary",
      evaluation: review, source: "api_generated", createdAt: now
    };
  }).filter(Boolean);
  if (!accepted.length) throw new Error("生成的测试用例未通过独立质量评估");
  await updateRagBuildProgress("running", "合并数据集", 92, `评估通过 ${accepted.length} 条，正在与已有 ${ragTestCases.length} 条测试数据去重合并...`);
  const nextTests = [...ragTestCases];
  const identities = new Set(nextTests.map((item) => normalizeArchiveText(item.question)));
  for (const item of accepted) {
    const identity = normalizeArchiveText(item.question);
    if (!identity) continue;
    if (identities.has(identity)) {
      const existingIndex = nextTests.findIndex((entry) => normalizeArchiveText(entry.question) === identity);
      if (existingIndex >= 0 && hasInternalRagLanguage(nextTests[existingIndex].expectedAnswer)) {
        nextTests[existingIndex] = { ...nextTests[existingIndex], ...item, id: nextTests[existingIndex].id || item.id, updatedAt: now };
      }
      continue;
    }
    identities.add(identity);
    nextTests.push(item);
  }
  if (nextTests.length > 500) nextTests.splice(0, nextTests.length - 500);
  await chrome.storage.local.set({ resumeKnowledgeBase: knowledgeBase, ragTestCases: nextTests });
  const added = nextTests.length - ragTestCases.length;
  await updateRagBuildProgress("complete", "构建完成", 100, `抽取 ${evidenceUnits.length} 条证据；生成 ${cases.length} 条；评估通过 ${accepted.length} 条；去重后新增 ${added} 条。`);
  return { ok: true, generated: cases.length, accepted: accepted.length, rejected: cases.length - accepted.length, added, testCases: accepted };
}

async function evaluateRagCasesInBatches(settings, evidenceUnits, cases) {
  const batchSize = 6;
  const concurrency = 2;
  const batches = [];
  for (let start = 0; start < cases.length; start += batchSize) {
    batches.push(cases.slice(start, start + batchSize).map((item, offset) => ({ item, globalIndex: start + offset })));
  }
  const evidenceMap = new Map(evidenceUnits.map((item) => [String(item.id), item]));
  const evidenceCatalog = evidenceUnits.map((item) => ({ id: item.id, category: item.category, title: item.title, skills: item.skills, retrievalHints: item.retrievalHints }));
  const evaluations = [];
  let nextBatch = 0;
  let completed = 0;

  const worker = async () => {
    while (nextBatch < batches.length) {
      const batchIndex = nextBatch++;
      const batch = batches[batchIndex];
      const relevantIds = new Set(batch.flatMap(({ item }) => Array.isArray(item.evidenceIds) ? item.evidenceIds.map(String) : []));
      const relevantEvidence = [...relevantIds].map((id) => evidenceMap.get(id)).filter(Boolean);
      const payloadCases = batch.map(({ item }, index) => ({ index, ...item }));
      const result = await callJsonModel(settings, [
        {
          role: "system",
          content: `你是独立的招聘RAG测试质量评估器。只评估本批用例，逐条核对测试用例与相关简历证据。按0-100评分：groundedness证据忠实度、answerability可回答性标注准确度、coverage代表性、naturalness招聘问题自然度、safety避免夸大与虚构。发现无证据事实必须 rejected=true；overall低于75或groundedness低于85也必须拒绝。回答出现“简历没有提供、知识库没有检索到、现有证据不足、无法回答、系统”等内部RAG语言时，naturalness不得超过40，必须在correctedExpectedAnswer中改写成“诚实边界 + 可迁移能力 + 补齐路径”的招聘沟通话术。保留输入中的index。只返回 JSON：{"evaluations":[{"index":0,"groundedness":0,"answerability":0,"coverage":0,"naturalness":0,"safety":0,"overall":0,"rejected":true,"issues":["问题"],"correctedExpectedAnswer":"必要时给出修正版"}]}`
        },
        { role: "user", content: JSON.stringify({ evidenceCatalog, relevantEvidence, cases: payloadCases }) }
      ], 0, 45000);
      for (const review of Array.isArray(result.evaluations) ? result.evaluations : []) {
        const localIndex = Number(review.index);
        if (!Number.isInteger(localIndex) || !batch[localIndex]) continue;
        evaluations.push({ ...review, index: batch[localIndex].globalIndex });
      }
      completed += 1;
      const percent = 72 + Math.round((completed / batches.length) * 18);
      await updateRagBuildProgress("running", "多维独立评估", percent, `评估批次 ${completed}/${batches.length} 已完成，已检查约 ${Math.min(completed * batchSize, cases.length)}/${cases.length} 条用例。`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, () => worker()));
  return evaluations;
}

async function updateRagBuildProgress(status, stage, percent, message) {
  await chrome.storage.local.set({
    ragBuildProgress: { status, stage, percent, message, updatedAt: new Date().toISOString() }
  });
}

async function callJsonModel(settings, messages, temperature = 0.1, timeoutMs = 75000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchWithRetry(`${settings.apiBaseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({ model: settings.model, temperature, response_format: { type: "json_object" }, messages })
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`AI 请求超过 ${Math.round(timeoutMs / 1000)} 秒，已自动终止，请重试`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new Error(`AI 结构化处理失败 (${response.status})`);
  const payload = await response.json();
  try {
    return JSON.parse(payload.choices?.[0]?.message?.content || "{}");
  } catch {
    throw new Error("AI 返回的结构化 JSON 无法解析");
  }
}

function fingerprintText(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${text.length}-${(hash >>> 0).toString(16)}`;
}

function hasInternalRagLanguage(value) {
  return /(?:简历|知识库|现有|当前).{0,8}(?:没有|未提及|未提供|未检索|缺少|不足)|无法(?:确认|回答)|没有搜索到|系统/.test(String(value || ""));
}

function rewriteBoundaryAnswer(question, answer) {
  if (!hasInternalRagLanguage(answer)) return answer;
  const text = String(question || "");
  if (/学历|专业|学校|毕业/.test(text)) {
    return "这部分信息我可以进一步如实补充说明。针对岗位匹配，我也愿意结合实际经历，重点介绍与岗位要求相关的能力、项目准备和后续发展方向。";
  }
  if (/职业规划|未来规划|发展方向|职业方向/.test(text)) {
    return "我希望继续围绕目标岗位需要的核心能力深入积累，在实际业务和项目中形成更完整的方法与交付能力。对于新的行业场景，我也会通过快速学习和实践尽快补齐。";
  }
  if (/经验|做过|项目|功能|负责过|接触过/.test(text)) {
    return "目前我还没有直接负责过这一具体场景，但已有经历中的方法和基础能力具备一定可迁移性。我愿意结合岗位要求快速熟悉业务，并通过实际任务尽快补齐相关经验。";
  }
  return "这方面我目前还没有足够直接的实践积累，但我愿意基于已有能力快速学习和适应，并结合岗位的实际要求尽快补齐。";
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

async function analyzeJob(job, runId = null, includeGreeting = true) {
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
          { role: "system", content: buildSystemPrompt(settings, includeGreeting) },
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
  const result = normalizeAnalysis(JSON.parse(content), settings, includeGreeting);
  return { ok: true, result };
}

async function generateJobGreeting(job, analysis = {}) {
  const { settings: stored } = await chrome.storage.local.get("settings");
  const settings = mergeSettings(DEFAULTS.settings, stored);
  validateSettings(settings);
  const value = await callJsonModel(settings, [
    {
      role: "system",
      content: `你是候选人的求职沟通助手。该岗位已经通过评分筛选，现在只生成一条中文招呼语。必须使用候选人第一人称，点出岗位需求与真实经历的对应关系，不得虚构项目、年限、成果或技能，不得写成HR邀请候选人的口吻。语气自然、不卑不亢，不写“精通”除非简历明确支持，不超过 ${settings.greetingMaxLength} 个汉字。只返回 JSON：{"greeting":"..."}`
    },
    { role: "user", content: JSON.stringify({ profile: settings.profile, job, matchedStrengths: analysis.matchedStrengths || [], concerns: analysis.concerns || [], score: analysis.score }) }
  ], 0.2, 45000);
  const greeting = String(value.greeting || "").trim().slice(0, settings.greetingMaxLength);
  if (!greeting) throw new Error("AI 未生成有效招呼语");
  return { ok: true, greeting };
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

function buildSystemPrompt(settings, includeGreeting = true) {
  return `你是应聘者的求职匹配助手，用户是正在求职的候选人，对方是招聘者或 HR。只依据提供的简历和岗位信息判断，绝不虚构经历。返回 JSON，字段必须为：score(0-100整数)、recommendation(apply/caution/skip)、summary(一句话)、matchedStrengths(字符串数组)、concerns(字符串数组)${includeGreeting ? "、greeting(中文招呼语)" : "。本阶段只评分，不得生成 greeting"}。
硬性条件请采用机会友好的兼容判断，而不是机械一票否决：候选人学历高于岗位要求时一定满足；候选人为本科、岗位写专科/大专时视为满足；候选人为硕士/研究生时视为满足本科、大专/专科要求。只有岗位明确要求更高学历且候选人确实达不到时，才将学历列为硬性不匹配。
工作年限允许合理弹性：岗位要求 3 年时，候选人有约 2 年真实相关经验可视为基本满足；岗位要求 5 年时，候选人有约 4 年可视为基本满足。对“年以上”要求默认允许少 1 年以内的差距，但必须在 concerns 中说明差距；如果差距超过 1 年、经验完全不相关，或岗位明确要求不可替代的资质，才判定为硬性不匹配。实习、项目和全职经历可按与岗位的相关程度合并评估，不得因为一年以内的差距直接 recommendation=skip。
${includeGreeting ? `greeting 必须使用候选人第一人称向招聘者打招呼，表达应聘意向；需要点出岗位需求与候选人真实优势的对应关系，不得写成 HR 邀请候选人面试或介绍职位的口吻。语气自然、不卑不亢，不写“精通”除非简历明确支持，不超过 ${settings.greetingMaxLength} 个汉字。` : "不要输出 greeting 字段，减少无效生成。"}评分低于 ${settings.minimumScore} 时 recommendation 不得为 apply。`;
}

function normalizeAnalysis(value, settings, includeGreeting = true) {
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
    greeting: includeGreeting ? String(value.greeting || "").slice(0, settings.greetingMaxLength) : ""
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
    description: cleanArchivedDescription(job.description || previousArchive?.description || "").slice(0, 10000),
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

function cleanArchivedDescription(value) {
  const lines = String(value || "").replace(/\r/g, "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const noise = /^(?:举报|微信扫码分享|扫码分享|分享至微信|分享|收藏|职位发布者|职位发布于|安全提示|求职安全提示|温馨提示)$/;
  while (lines.length && (noise.test(lines[0]) || /^(?:举报|微信扫码|扫码分享)/.test(lines[0]))) lines.shift();
  const firstContent = lines.findIndex((line) => /职位描述|岗位职责|工作职责|任职要求|岗位要求|工作内容|职位要求/.test(line));
  return (firstContent > 0 ? lines.slice(firstContent) : lines).filter((line) => !noise.test(line)).join("\n").trim();
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
