const SELECTORS = {
  detailRoot: [".job-detail", ".job-detail-box", ".job-detail-container", ".job-detail-section"],
  title: [".job-detail-info .name", ".job-name", "h1"],
  salary: [".job-detail-info .salary", ".salary"],
  description: [".job-sec-text", ".job-detail-section .text", ".job-description"],
  company: [".company-info .name", ".company-name", ".sider-company .company-info a"],
  recruiter: [".boss-info-attr .name", ".boss-name", ".job-boss-info .name"],
  recruiterRoot: [".boss-info-attr", ".job-boss-info", ".boss-info", "[class*='boss-info']"],
  city: [".job-detail-info .text-desc", ".job-location", ".location-address"],
  communicate: [".btn-startchat", ".btn-container .btn", "a.btn-startchat", "button"],
  editor: [
    ".chat-input[contenteditable='true']",
    ".chat-input [contenteditable='true']",
    ".chat-input textarea",
    ".chat-input",
    "textarea",
    "[contenteditable='true']"
  ]
};

const JOB_CARD_SELECTORS = [
  ".job-list-box .job-card-box",
  ".job-list-container .job-card-box",
  ".job-card-box",
  ".job-card-wrap",
  ".job-list-box .job-card-wrapper",
  ".job-list-container .job-card-wrapper",
  ".job-card-wrapper",
  ".job-list-box li",
  ".job-list-container li",
  ".job-list li",
  "[class*='job-card']",
  "[class*='job-item']"
];
let pageAutomationCancelled = false;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_CURRENT_JOB") {
    try {
      sendResponse({ ok: true, job: extractCurrentJob() });
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
    return;
  }
  if (message?.type === "FILL_GREETING") {
    fillGreeting(message.text, Boolean(message.send), message.jobId, Boolean(message.closeTab), message.closeTabId)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "GET_JOB_LIST") {
    sendResponse({ ok: true, jobs: extractJobList() });
    return;
  }
  if (message?.type === "SELECT_JOB") {
    selectJobCard(message.job)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "GET_SEARCH_CONTEXT") {
    sendResponse({ ok: true, currentRole: extractCurrentRecommendedRole() });
    return;
  }
  if (message?.type === "SEARCH_JOBS") {
    pageAutomationCancelled = false;
    searchJobs(message.keyword)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "CANCEL_PAGE_AUTOMATION") {
    pageAutomationCancelled = true;
    sendResponse({ ok: true });
    return;
  }
  if (message?.type === "OPEN_MESSAGES") {
    openMessages()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "GET_CHAT_THREADS") {
    sendResponse({ ok: true, threads: extractChatThreads() });
    return;
  }
  if (message?.type === "SELECT_CHAT_THREAD") {
    selectChatThread(message.thread)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "GET_CHAT_CONTEXT") {
    sendResponse({ ok: true, context: extractChatContext() });
    return;
  }
  if (message?.type === "SEND_CHAT_REPLY") {
    sendChatReply(message.text, Boolean(message.send))
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "SEND_RESUME") {
    sendResume()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "GET_ZHILIAN_JOB_LIST") {
    if (isZhilianVerificationPage()) sendResponse({ ok: false, verificationRequired: true, error: "智联要求手动完成人机验证" });
    else sendResponse({ ok: true, jobs: extractZhilianJobList() });
    return;
  }
  if (message?.type === "CHECK_ZHILIAN_VERIFICATION") {
    sendResponse({ ok: true, verificationRequired: isZhilianVerificationPage() });
    return;
  }
  if (message?.type === "SEARCH_ZHILIAN_JOBS") {
    searchZhilianJobs(message.keyword)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "LOAD_MORE_ZHILIAN_JOBS") {
    loadMoreZhilianJobs()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "NEXT_ZHILIAN_PAGE") {
    goToNextZhilianPage()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "GET_ZHILIAN_PAGINATION") {
    const pagination = findZhilianPagination();
    const next = pagination ? [...pagination.querySelectorAll("button, a, li, span, [role='button']")].find((item) => item.innerText?.trim() === "下一页") : null;
    sendResponse({
      ok: true,
      currentPage: getZhilianCurrentPage(pagination),
      canAdvance: Boolean(next && !next.disabled && next.getAttribute("aria-disabled") !== "true" && !/disabled/.test(next.className))
    });
    return;
  }
  if (message?.type === "GET_ZHILIAN_JOB_DETAIL") {
    if (isZhilianVerificationPage()) {
      sendResponse({ ok: false, verificationRequired: true, error: "智联要求手动完成人机验证" });
      return;
    }
    try { sendResponse({ ok: true, job: extractZhilianJobDetail() }); }
    catch (error) { sendResponse({ ok: false, error: error.message }); }
    return;
  }
  if (message?.type === "APPLY_ZHILIAN_JOB") {
    applyZhilianJob()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "OPEN_ZHILIAN_JOB") {
    try { sendResponse(openZhilianJob(message.job)); }
    catch (error) { sendResponse({ ok: false, error: error.message }); }
    return;
  }
  if (message?.type === "LOAD_MORE_JOBS") {
    loadMoreJobs()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
});

let lastJobSignature = "";
let changeTimer;
const detailObserver = new MutationObserver(() => {
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => {
    try {
      const job = extractCurrentJob();
      const signature = `${job.jobId}|${job.title}|${job.company}`;
      if (lastJobSignature && signature !== lastJobSignature) {
        chrome.runtime.sendMessage({ type: "JOB_PAGE_CHANGED" }).catch(() => {});
      }
      lastJobSignature = signature;
    } catch {
      // The detail pane is temporarily empty while the site switches jobs.
    }
  }, 350);
});
if (location.hostname.endsWith("zhipin.com")) {
  detailObserver.observe(document.body, { childList: true, subtree: true });
  processPendingGreeting().catch(async (error) => {
    console.warn("BOSS 求职助手：继续沟通失败", error);
    await reportFlowStage("error", "恢复沟通流程失败", error.message);
  });
}

function extractCurrentJob() {
  const root = firstElement(SELECTORS.detailRoot) || document;
  const title = textOf(root, SELECTORS.title) || inferHeading(root);
  const salary = decodeBossText(textOf(root, SELECTORS.salary));
  const description = textOf(root, SELECTORS.description) || inferDescription(root);
  const company = textOf(document, SELECTORS.company);
  const recruiter = textOf(document, SELECTORS.recruiter);
  const recruiterActivity = extractRecruiterActivity();
  const city = inferCity(textOf(root, SELECTORS.city), root.innerText);
  const url = location.href;
  const jobId = new URL(url).searchParams.get("jobId") || stableId(`${title}|${company}|${description.slice(0, 120)}`);
  const salaryRange = parseSalary(salary);

  if (!title || !description) throw new Error("未识别到岗位详情，请先在左侧选择一个岗位");
  return {
    jobId,
    title,
    salary,
    salaryMinK: salaryRange.min,
    salaryMaxK: salaryRange.max,
    company,
    recruiter,
    recruiterActivity,
    city,
    description: description.slice(0, 10000),
    url,
    capturedAt: new Date().toISOString()
  };
}

function extractRecruiterActivity() {
  const roots = uniqueElements(SELECTORS.recruiterRoot.flatMap((selector) => [...document.querySelectorAll(selector)]));
  const source = roots.map((root) => root.innerText?.trim() || "").join(" ");
  const patterns = [
    /(?:刚刚|今日|今天|昨日|昨天|本周|本月|近\d+[天日周月])(?:在线|活跃|登录)/,
    /\d+\s*(?:分钟|小时|天|日|周|个月|月|年)前(?:在线|活跃|登录)/,
    /(?:在线|活跃|登录)于?\d+\s*(?:天|日|周|个月|月|年)前/,
    /\d+\s*(?:天|日|周|个月|月|年)(?:未在线|未活跃|未登录)/,
    /(?:半年|一年|很久|长期)(?:未在线|未活跃|未登录|前活跃)/,
    /(?:在线|活跃中)/
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) return match[0].replace(/\s+/g, "");
  }
  return "";
}

function extractJobList() {
  const cards = discoverJobCards();
  return cards.map((card, index) => {
    const data = extractCardData(card);
    const { title, company, salary, url } = data;
    return { key: stableId(`${title}|${company}|${index}`), title, company, salary, url, index };
  }).filter((job) => job.title);
}

async function selectJobCard(job) {
  const cards = discoverJobCards();
  const card = cards.find((item, index) => {
    const { title, company } = extractCardData(item);
    return (job.title && title === job.title && (!job.company || company === job.company)) || index === job.index;
  });
  if (!card) throw new Error(`未找到岗位卡片：${job.title}`);
  let previousJobId = "";
  try { previousJobId = extractCurrentJob().jobId; } catch { /* Detail may be empty before selection. */ }
  const clickable = firstElement([".job-card-body", ".job-card-left", ".job-name", "a"], card) || card;
  clickable.scrollIntoView({ block: "center", behavior: "auto" });
  clickable.click();
  const selectedJob = await waitForJobDetail(job.title, previousJobId, 10000);
  return { ok: true, jobId: selectedJob.jobId, title: selectedJob.title };
}

function discoverJobCards() {
  const linkedCards = [...document.querySelectorAll("a[href*='/job_detail/'], a[href*='job_detail'], a[href*='securityId']")]
    .map((anchor) => anchor.closest(".job-card-box, .job-card-wrapper, .job-card-wrap, [class*='job-card'], li, article") || anchor)
    .filter(isLikelyJobCard);
  if (linkedCards.length) return sortAndDedupeCards(linkedCards);

  const explicit = uniqueElements(JOB_CARD_SELECTORS.flatMap((selector) => [...document.querySelectorAll(selector)]))
    .filter(isLikelyJobCard);
  if (explicit.length) return sortAndDedupeCards(explicit);

  const generic = [...document.querySelectorAll("li, article, div")].filter(isLikelyJobCard);
  return sortAndDedupeCards([...explicit, ...generic]);
}

function isLikelyJobCard(element) {
  const text = element.innerText?.trim() || "";
  const hasJobMarker = Boolean(element.querySelector(".job-name, .job-title, [class*='job-name'], [class*='job-title'], a[href*='job_detail']"));
  if (text.length < 5 || text.length > 1200 || (!salaryFromText(text) && !hasJobMarker)) return false;
  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height || rect.bottom < 60) return false;
  const leftRegion = rect.left < window.innerWidth * 0.55;
  const cardSize = rect.width >= 180 && rect.width <= Math.min(850, window.innerWidth * 0.55)
    && rect.height >= 55 && rect.height <= 420;
  return leftRegion && cardSize;
}

function sortAndDedupeCards(elements) {
  const sorted = uniqueElements(elements).sort((a, b) => {
    const aRect = a.getBoundingClientRect();
    const bRect = b.getBoundingClientRect();
    if (Math.abs(aRect.top - bRect.top) > 8) return aRect.top - bRect.top;
    return (bRect.width * bRect.height) - (aRect.width * aRect.height);
  });
  const result = [];
  for (const element of sorted) {
    const rect = element.getBoundingClientRect();
    const sameRow = result.some((existing) => Math.abs(existing.getBoundingClientRect().top - rect.top) < 18);
    if (!sameRow) result.push(element);
  }
  return result;
}

function extractCardData(card) {
  const fullText = decodeBossText(card.innerText?.trim() || "");
  const salary = decodeBossText(textOf(card, [".salary", ".job-salary", "[class*='salary']"])) || salaryFromText(fullText);
  let title = textOf(card, [".job-name", ".job-title", ".job-card-left .name", "[class*='job-name']", "h3"]);
  const lines = fullText.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  if (!title) {
    const salaryLine = lines.find((line) => salaryFromText(line));
    title = salaryLine?.replace(salaryFromText(salaryLine), "").trim() || lines[0] || "";
  }
  let company = textOf(card, [".company-name", ".company-info .name", ".company-text .name", "[class*='company-name']"]);
  if (!company) {
    company = [...lines].reverse().find((line) => isLikelyCompanyLine(line, title, salary)) || "";
  }
  const anchor = card.matches("a[href]") ? card : card.querySelector("a[href]");
  const url = anchor?.href || "";
  return { title: title.trim(), company: company.trim(), salary, url };
}

function salaryFromText(text) {
  return decodeBossText(text).match(/\d+(?:\.\d+)?\s*[-–~]\s*\d+(?:\.\d+)?\s*[Kk](?:\s*[·+]\s*\d+薪)?/)?.[0] || "";
}

function decodeBossText(value) {
  return String(value || "").replace(/[\uE031-\uE03A]/g, (character) => String(character.charCodeAt(0) - 0xE031));
}

function isLikelyCompanyLine(line, title, salary) {
  if (!line || line === title || line.includes(salary) || line.length > 40) return false;
  if (/^(经验不限|学历不限|\d+[-–]\d+年|本科|大专|硕士|博士|应届生)/.test(line)) return false;
  if (/^(北京|上海|天津|重庆|深圳|广州|杭州|成都|武汉|西安|南京|苏州|长沙|郑州|青岛|厦门|合肥|昆明|宁波|东莞)[··]/.test(line)) return false;
  return true;
}

async function fillGreeting(text, shouldSend, jobId, closeTab = false, closeTabId = null) {
  if (!text?.trim()) throw new Error("招呼语为空");
  let editor = firstVisible(SELECTORS.editor);
  if (editor) return fillChatEditor(editor, text.trim(), shouldSend);

  const pending = {
    text: text.trim(),
    shouldSend,
    jobId: jobId || null,
    closeTab,
    closeTabId,
    createdAt: Date.now()
  };
  await chrome.storage.local.set({ pendingGreeting: pending });
  await reportFlowStage("info", "沟通小窗已接管投递流程", { jobId, url: location.href });

  const communicateButton = findButton(["立即沟通", "打招呼"]);
  if (!communicateButton) {
    await chrome.storage.local.remove("pendingGreeting");
    throw new Error("未找到“立即沟通”按钮，页面结构可能已变化");
  }
  communicateButton.click();
  await reportFlowStage("info", "已点击立即沟通", { jobId });

  const continueButton = await waitForButton(["继续沟通"], 10000);
  if (!continueButton) {
    await chrome.storage.local.remove("pendingGreeting");
    throw new Error("已点击立即沟通，但未找到“继续沟通”按钮");
  }
  continueButton.click();
  await reportFlowStage("info", "已点击继续沟通，等待聊天输入框", { jobId });
  processPendingGreeting().catch((error) => {
    reportFlowStage("error", "小窗内继续沟通失败", error.message);
  });
  return { ok: true, pending: true, sent: false };
}

async function processPendingGreeting() {
  const { pendingGreeting } = await chrome.storage.local.get("pendingGreeting");
  if (!pendingGreeting?.text) return;
  if (Date.now() - pendingGreeting.createdAt > 2 * 60 * 1000) {
    await chrome.storage.local.remove("pendingGreeting");
    return;
  }
  const editor = await waitForVisible(SELECTORS.editor, 15000);
  if (!editor) throw new Error("消息页已打开，但未找到聊天输入框");
  const { pendingGreeting: latestPending } = await chrome.storage.local.get("pendingGreeting");
  if (!latestPending || latestPending.createdAt !== pendingGreeting.createdAt) return;
  await reportFlowStage("info", "已找到聊天输入框", { jobId: pendingGreeting.jobId, url: location.href });
  const result = await fillChatEditor(editor, pendingGreeting.text, pendingGreeting.shouldSend);
  await reportFlowStage("info", result.sent ? "消息已发送" : "招呼语已填入", { jobId: pendingGreeting.jobId });
  await chrome.storage.local.remove("pendingGreeting");
  await chrome.runtime.sendMessage({
    type: "COMPLETE_GREETING_FLOW",
    jobId: pendingGreeting.jobId,
    status: result.sent ? "sent" : "filled",
    closeTab: Boolean(pendingGreeting.closeTab),
    closeTabId: pendingGreeting.closeTabId
  });
}

async function reportFlowStage(level, message, detail = null) {
  try {
    await chrome.runtime.sendMessage({ type: "GREETING_FLOW_STAGE", level, message, detail });
  } catch {
    // The side panel may be closed; the greeting flow should continue independently.
  }
}

function extractCurrentRecommendedRole() {
  const selectors = [
    ".recommend-job-btn", ".job-tab-box .active", ".condition-position .current",
    "[class*='recommend'] [class*='active']", "[class*='position'] [class*='active']"
  ];
  for (const selector of selectors) {
    const text = document.querySelector(selector)?.innerText?.trim();
    const role = text?.replace(/^推荐[|｜]?\s*/, "").trim();
    if (role && role !== "推荐" && role.length <= 40 && !/搜索|筛选/.test(role)) return role;
  }
  const candidates = [...document.querySelectorAll("header button, header a, nav button, nav a, [class*='search'] button")];
  const text = candidates.map((item) => item.innerText?.trim()).find((value) => value && /推荐[|｜]/.test(value));
  if (text) return text.replace(/^推荐[|｜]\s*/, "");

  const searchInput = [...document.querySelectorAll("input")].find((item) => /搜索职位/.test(item.placeholder || ""));
  if (!searchInput) return "";
  const searchRect = searchInput.getBoundingClientRect();
  const topLabels = [...document.querySelectorAll("a, button, span, div")]
    .filter((item) => {
      const rect = item.getBoundingClientRect();
      const value = item.innerText?.trim() || "";
      return rect.width > 40 && rect.width < 240 && rect.height < 60
        && rect.right < searchRect.left && Math.abs(rect.top - searchRect.top) < 45
        && value.length >= 3 && value.length <= 30 && !/^(推荐|首页|职位|公司)$/.test(value);
    })
    .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
  return topLabels[0]?.innerText?.trim() || "";
}

async function searchJobs(keyword) {
  const value = String(keyword || "").trim();
  if (!value) throw new Error("搜索关键词为空");
  const previousSignature = extractJobList().slice(0, 5).map((job) => `${job.title}|${job.company}`).join(";");
  const inputs = [...document.querySelectorAll("input")];
  const input = inputs.find((item) => item.getClientRects().length && (
    /职位|岗位|搜索/.test(item.placeholder || "") || /search|query|keyword/i.test(`${item.name} ${item.className}`)
  ));
  if (!input) throw new Error("未识别到 BOSS 搜索框");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter ? setter.call(input, value) : (input.value = value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  const root = input.closest("form, [class*='search']") || document;
  const button = findButton(["搜索"], root);
  if (button) button.click();
  else input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
  await waitForJobListRefresh(value, previousSignature, 12000);
  const jobs = extractJobList();
  return { ok: true, jobs, keyword: value, diagnostics: jobs.length ? null : collectJobListDiagnostics() };
}

async function waitForJobListRefresh(keyword, previousSignature, timeout) {
  const startedAt = Date.now();
  await delay(700);
  while (Date.now() - startedAt < timeout) {
    if (pageAutomationCancelled) return false;
    const jobs = extractJobList();
    const signature = jobs.slice(0, 5).map((job) => `${job.title}|${job.company}`).join(";");
    if (jobs.length && (signature !== previousSignature || Date.now() - startedAt > 3000)) return;
    await delay(300);
  }
  return false;
}

async function loadMoreJobs() {
  const cards = discoverJobCards();
  const previousSignature = jobListSignature(extractJobList());
  const lastCard = cards[cards.length - 1];
  const scrollContainer = findScrollableJobContainer(lastCard);
  let before;
  if (scrollContainer) {
    before = { top: scrollContainer.scrollTop, height: scrollContainer.scrollHeight, viewport: scrollContainer.clientHeight };
    scrollContainer.scrollTop = Math.min(
      scrollContainer.scrollHeight,
      scrollContainer.scrollTop + Math.max(scrollContainer.clientHeight * 0.85, 500)
    );
    scrollContainer.dispatchEvent(new Event("scroll", { bubbles: true }));
  } else {
    before = { top: window.scrollY, height: document.documentElement.scrollHeight, viewport: window.innerHeight };
    window.scrollBy({ top: Math.max(window.innerHeight * 0.85, 600), behavior: "auto" });
  }
  const startedAt = Date.now();
  let jobs = extractJobList();
  while (Date.now() - startedAt < 6000) {
    if (pageAutomationCancelled) return { ok: true, jobs: extractJobList(), cancelled: true };
    await delay(400);
    jobs = extractJobList();
    if (jobListSignature(jobs) !== previousSignature) break;
  }
  const after = scrollContainer
    ? { top: scrollContainer.scrollTop, height: scrollContainer.scrollHeight, viewport: scrollContainer.clientHeight }
    : { top: window.scrollY, height: document.documentElement.scrollHeight, viewport: window.innerHeight };
  return {
    ok: true,
    jobs,
    scroll: {
      before,
      after,
      moved: after.top > before.top,
      atBottom: after.top + after.viewport >= after.height - 20
    }
  };
}

function jobListSignature(jobs) {
  return jobs.map((job) => job.url || `${job.title}|${job.company}`).join(";");
}

function findScrollableJobContainer(element) {
  let current = element?.parentElement;
  while (current && current !== document.body) {
    const style = getComputedStyle(current);
    if (/(auto|scroll)/.test(style.overflowY) && current.scrollHeight > current.clientHeight + 30) return current;
    current = current.parentElement;
  }
  return null;
}

function collectJobListDiagnostics() {
  const detailLinks = [...document.querySelectorAll("a[href*='job_detail'], a[href*='securityId']")];
  const classCandidates = [...document.querySelectorAll("[class*='job-card'], [class*='job-list'], [class*='job-item']")];
  return {
    url: location.href,
    detailLinks: detailLinks.length,
    classCandidates: classCandidates.length,
    candidateClasses: [...new Set(classCandidates.slice(0, 20).map((item) => item.className).filter((value) => typeof value === "string"))].slice(0, 10),
    visibleSamples: classCandidates.filter((item) => item.getClientRects().length).slice(0, 5).map((item) => (item.innerText || "").trim().slice(0, 160))
  };
}

async function openMessages() {
  const link = [...document.querySelectorAll("a, button, [role='button']")].find((item) => item.innerText?.trim() === "消息");
  if (!link) throw new Error("未找到顶部“消息”入口");
  link.click();
  return { ok: true, navigating: true };
}

function extractChatThreads() {
  const selectors = [
    ".chat-list li", ".user-list li", ".conversation-list li", ".chat-user-list li",
    "[class*='chat-item']", "[class*='conversation-item']", "[class*='friend-item']"
  ];
  let elements = uniqueElements(selectors.flatMap((selector) => [...document.querySelectorAll(selector)]))
    .filter(isLikelyChatThread);
  if (!elements.length) {
    elements = [...document.querySelectorAll("li, article, div")].filter(isLikelyChatThread);
  }
  return sortAndDedupeChatThreads(elements).map((element, index) => {
    const text = element.innerText?.trim() || "";
    const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    const preview = lines[lines.length - 1] || "";
    const outgoingPreview = /^\[(?:送达|已读)\]/.test(preview);
    const followUpCandidate = /^\[已读\]/.test(preview);
    const hoursSince = estimateThreadAgeHours(lines);
    const unread = /unread|new-msg|has-new/i.test(element.className)
      || Boolean(element.querySelector("[class*='unread'], [class*='badge'], [class*='new-msg']"));
    return {
      key: stableId(`${lines.slice(0, 3).join("|")}|${index}`),
      index,
      recruiter: lines[0] || "",
      company: lines[1] || "",
      preview,
      unread,
      needsReply: !outgoingPreview || (followUpCandidate && hoursSince >= 48),
      followUpCandidate,
      hoursSince,
      priority: unread ? 0 : (!outgoingPreview ? 1 : 2)
    };
  }).filter((thread) => thread.recruiter).sort((a, b) => a.priority - b.priority || a.index - b.index);
}

function estimateThreadAgeHours(lines) {
  const text = lines.join(" ");
  if (/昨天/.test(text)) return 24;
  const dateMatch = text.match(/(\d{1,2})[-/.](\d{1,2})/);
  if (dateMatch) {
    const now = new Date();
    let date = new Date(now.getFullYear(), Number(dateMatch[1]) - 1, Number(dateMatch[2]));
    if (date > now) date = new Date(now.getFullYear() - 1, Number(dateMatch[1]) - 1, Number(dateMatch[2]));
    return Math.max(0, (now - date) / 3600000);
  }
  return 0;
}

function isLikelyChatThread(element) {
  const text = element.innerText?.trim() || "";
  if (text.length < 3 || text.length > 350) return false;
  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height || rect.left > window.innerWidth * 0.42) return false;
  if (rect.height < 45 || rect.height > 180 || rect.width < 180 || rect.width > window.innerWidth * 0.42) return false;
  return /\d{1,2}:\d{2}|昨天|星期|\[(?:送达|已读)\]/.test(text)
    || Boolean(element.querySelector("img, [class*='avatar']"));
}

function sortAndDedupeChatThreads(elements) {
  const sorted = uniqueElements(elements).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  const result = [];
  for (const element of sorted) {
    const rect = element.getBoundingClientRect();
    if (!result.some((item) => Math.abs(item.getBoundingClientRect().top - rect.top) < 12)) result.push(element);
  }
  return result;
}

async function selectChatThread(thread) {
  const elements = sortAndDedupeChatThreads([
    ...document.querySelectorAll(".chat-list li, .user-list li, .conversation-list li, .chat-user-list li, [class*='chat-item'], [class*='conversation-item']")
  ].filter(isLikelyChatThread));
  const target = elements[thread.index] || elements.find((element) => element.innerText?.includes(thread.recruiter));
  if (!target) throw new Error(`未找到聊天会话：${thread.recruiter}`);
  target.scrollIntoView({ block: "center", behavior: "auto" });
  target.click();
  await delay(900);
  return { ok: true };
}

function extractChatContext() {
  const header = firstVisible([".chat-conversation .title", ".chat-header", ".conversation-header", "[class*='chat-header']"]);
  const headerText = header?.innerText?.trim() || "";
  const messageElements = uniqueElements([
    ...document.querySelectorAll(".message-item, .chat-message, [class*='message-item'], [class*='message-content'], [class*='chat-record']")
  ]).filter((element) => {
    const rect = element.getBoundingClientRect();
    const text = element.innerText?.trim() || "";
    return text && text.length < 2000 && rect.left > window.innerWidth * 0.25;
  });
  const messages = messageElements.map((element) => {
    const rect = element.getBoundingClientRect();
    const outgoing = /self|myself|right|mine/i.test(element.className) || rect.left > window.innerWidth * 0.58;
    return { role: outgoing ? "candidate" : "recruiter", text: element.innerText.trim().slice(0, 1200) };
  });
  const deduped = messages.filter((message, index) => index === 0 || message.text !== messages[index - 1].text);
  const latestIncoming = [...deduped].reverse().find((message) => message.role === "recruiter")?.text || "";
  const jobTitle = textOf(document, [".job-title", ".position-name", "[class*='job-title']", "[class*='position-name']"])
    || headerText.split(/\n/).find((line) => /工程师|经理|分析|开发|运营|产品|设计|销售|顾问/.test(line)) || "";
  const company = headerText.split(/\n|\s{2,}/).find((line) => /公司|科技|集团|咨询|事务所|中心/.test(line)) || "";
  return { headerText, jobTitle, company, messages: deduped.slice(-30), latestIncoming, url: location.href };
}

async function sendChatReply(text, shouldSend) {
  const editor = await waitForVisible(SELECTORS.editor, 5000);
  if (!editor) throw new Error("未找到聊天输入框");
  return fillChatEditor(editor, text, shouldSend);
}

async function sendResume() {
  const button = findButton(["发简历", "发送简历"]);
  if (!button) return { ok: false, error: "当前会话没有可用的“发简历”按钮" };
  button.click();
  await delay(600);
  const dialog = firstVisible(["[role='dialog']", ".dialog-container", ".boss-dialog", "[class*='dialog-wrap']"]);
  const confirmButton = dialog ? findButton(["确认发送", "确定"], dialog) : null;
  if (confirmButton) confirmButton.click();
  return { ok: true };
}

function extractZhilianJobList() {
  const anchors = [...document.querySelectorAll("a[href]")].filter((anchor) => (
    /\/jobdetail\/|jobs\.zhaopin\.com/i.test(anchor.href)
  ));
  const cards = uniqueElements(anchors.map((anchor) => (
    anchor.closest("[class*='joblist-box'], [class*='job-card'], [class*='position-card'], li, article") || anchor
  )));
  return cards.map((card, index) => {
    const anchor = card.matches("a[href]") ? card : card.querySelector("a[href*='jobdetail'], a[href*='jobs.zhaopin.com']");
    const text = decodeBossText(card.innerText || "");
    const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    const title = textOf(card, ["[class*='job-name']", "[class*='position-name']", "h3", "h2"])
      || anchor?.innerText?.trim() || lines[0] || "";
    const salary = text.match(/\d+(?:\.\d+)?\s*[-–~]\s*\d+(?:\.\d+)?\s*(?:K|千|元)(?:[·+]\d+薪)?/i)?.[0] || "";
    const company = textOf(card, ["[class*='company-name']", "[class*='company-title']"])
      || lines.find((line) => /公司|集团|事务所|中心/.test(line)) || "";
    const applied = /已投递/.test(text);
    return { key: stableId(anchor?.href || `${title}|${company}|${index}`), index, title, company, salary, url: anchor?.href || "", applied };
  }).filter((job) => job.title && job.url);
}

function openZhilianJob(job) {
  const anchors = [...document.querySelectorAll("a[href]")].filter((anchor) => /\/jobdetail\/|jobs\.zhaopin\.com/i.test(anchor.href));
  const target = anchors.find((anchor) => anchor.href === job.url)
    || anchors.find((anchor) => anchor.innerText?.trim().includes(job.title));
  if (!target) return { ok: false, error: `未在智联列表找到岗位链接：${job.title}` };
  target.target = "_blank";
  target.rel = "noopener";
  target.click();
  return { ok: true, clicked: true };
}

async function searchZhilianJobs(keyword) {
  if (isZhilianVerificationPage()) return { ok: false, verificationRequired: true, error: "智联要求手动完成人机验证" };
  const value = String(keyword || "").trim();
  if (!value) throw new Error("智联搜索关键词为空");
  const input = [...document.querySelectorAll("input")].find((item) => item.getClientRects().length && /搜索职位|职位.*公司|请输入.*职位/.test(item.placeholder || ""));
  if (!input) throw new Error("未识别到智联职位搜索框");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter ? setter.call(input, value) : (input.value = value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  const root = input.closest("form, [class*='search']") || document;
  const button = findButton(["搜索"], root) || findButton(["搜索"]);
  if (button) button.click();
  else input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
  await delay(1800);
  if (isZhilianVerificationPage()) return { ok: false, verificationRequired: true, error: "智联要求手动完成人机验证" };
  return { ok: true, jobs: extractZhilianJobList(), keyword: value };
}

async function loadMoreZhilianJobs() {
  if (isZhilianVerificationPage()) return { ok: false, verificationRequired: true, error: "智联要求手动完成人机验证" };
  const previous = zhilianListSignature(extractZhilianJobList());
  window.scrollBy({ top: Math.max(window.innerHeight * 0.85, 700), behavior: "auto" });
  const startedAt = Date.now();
  let jobs = extractZhilianJobList();
  while (Date.now() - startedAt < 6000) {
    if (pageAutomationCancelled) return { ok: true, jobs, cancelled: true };
    await delay(400);
    jobs = extractZhilianJobList();
    if (zhilianListSignature(jobs) !== previous) break;
  }
  return {
    ok: true,
    jobs,
    atBottom: window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 30
  };
}

async function goToNextZhilianPage() {
  if (isZhilianVerificationPage()) return { ok: false, verificationRequired: true, error: "智联要求手动完成人机验证" };
  const pagination = findZhilianPagination();
  if (!pagination) return { ok: true, hasNext: false, jobs: extractZhilianJobList(), currentPage: null };
  const next = [...pagination.querySelectorAll("button, a, li, span, [role='button']")]
    .find((item) => item.innerText?.trim() === "下一页");
  const disabled = !next || next.disabled || next.getAttribute("aria-disabled") === "true"
    || /disabled/.test(next.className) || next.getClientRects().length === 0;
  if (disabled) return { ok: true, hasNext: false, jobs: extractZhilianJobList(), currentPage: getZhilianCurrentPage(pagination) };

  const previousSignature = zhilianListSignature(extractZhilianJobList());
  const previousPage = getZhilianCurrentPage(pagination);
  next.click();
  const startedAt = Date.now();
  let jobs = extractZhilianJobList();
  while (Date.now() - startedAt < 10000) {
    await delay(350);
    if (isZhilianVerificationPage()) return { ok: false, verificationRequired: true, error: "智联要求手动完成人机验证" };
    jobs = extractZhilianJobList();
    const currentPagination = findZhilianPagination();
    const currentPage = getZhilianCurrentPage(currentPagination);
    if (zhilianListSignature(jobs) !== previousSignature || (currentPage && currentPage !== previousPage)) {
      window.scrollTo({ top: 0, behavior: "auto" });
      return { ok: true, hasNext: true, jobs, currentPage };
    }
  }
  throw new Error("点击智联下一页后，岗位列表未发生变化");
}

function findZhilianPagination() {
  const candidates = [...document.querySelectorAll("nav, ul, div")].filter((item) => {
    const text = item.innerText?.replace(/\s+/g, "") || "";
    const rect = item.getBoundingClientRect();
    return rect.width > 180 && rect.height < 160 && text.includes("上一页") && text.includes("下一页");
  });
  return candidates.sort((a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width)[0] || null;
}

function getZhilianCurrentPage(pagination) {
  if (!pagination) return null;
  const active = pagination.querySelector("[aria-current='page'], [class*='active'], [class*='selected']");
  const value = active?.innerText?.trim();
  return /^\d+$/.test(value || "") ? Number(value) : null;
}

function isZhilianVerificationPage() {
  const text = document.body?.innerText || "";
  return /确认您是真人|正在验证连接安全性|验证完成后.*重定向|Tencent Cloud EdgeOne/i.test(text);
}

function zhilianListSignature(jobs) {
  return jobs.map((job) => job.url).join(";");
}

function extractZhilianJobDetail() {
  const root = firstVisible(["[class*='job-detail']", "[class*='jobDetail']", "main"]) || document;
  const bodyText = decodeBossText(document.body.innerText || "");
  const title = textOf(document, ["h1", "[class*='job-name']", "[class*='position-name']"]);
  const salary = decodeBossText(textOf(document, ["[class*='salary']", "[class*='job-salary']"]))
    || bodyText.match(/\d+(?:\.\d+)?\s*[-–~]\s*\d+(?:\.\d+)?\s*(?:K|千|元)(?:[·+]\d+薪)?/i)?.[0] || "";
  const description = inferZhilianDescription(root);
  const company = textOf(document, ["[class*='company-name']", "[class*='company-title']"])
    || [...document.querySelectorAll("a, div")].map((item) => item.innerText?.trim()).find((text) => text && text.length < 60 && /公司|集团|事务所|中心/.test(text)) || "";
  const city = inferCity("", bodyText);
  const jobId = stableId(location.href || `${title}|${company}`);
  const salaryRange = parseZhilianSalary(salary);
  if (!title || !description) throw new Error("未识别到智联岗位详情");
  return {
    jobId, title, salary, salaryMinK: salaryRange.min, salaryMaxK: salaryRange.max,
    company, city, recruiter: "", recruiterActivity: "", description: description.slice(0, 10000),
    url: location.href, platform: "zhilian", capturedAt: new Date().toISOString()
  };
}

function inferZhilianDescription(root) {
  const candidates = [...root.querySelectorAll("section, article, div")].map((item) => item.innerText?.trim() || "")
    .filter((text) => /职位描述|岗位职责|任职资格|任职要求/.test(text) && text.length > 80 && text.length < 20000);
  return candidates.sort((a, b) => a.length - b.length)[0] || "";
}

function parseZhilianSalary(value) {
  const text = String(value || "");
  const match = text.match(/(\d+(?:\.\d+)?)\s*[-–~]\s*(\d+(?:\.\d+)?)\s*(K|千|元)/i);
  if (!match) return { min: null, max: null };
  const unit = match[3].toLowerCase();
  const divisor = unit === "元" ? 1000 : 1;
  return { min: Number(match[1]) / divisor, max: Number(match[2]) / divisor };
}

async function applyZhilianJob() {
  const already = findButton(["已投递"]);
  if (already) return { ok: true, applied: false, already: true };
  const button = findButton(["立即投递"]);
  if (!button) throw new Error("未找到智联“立即投递”按钮");
  button.click();
  await delay(700);
  const dialog = firstVisible(["[role='dialog']", "[class*='modal']", "[class*='dialog']"]);
  const confirmButton = dialog ? findButton(["确认投递", "立即投递"], dialog) : null;
  if (confirmButton) confirmButton.click();
  return { ok: true, applied: true };
}

async function fillChatEditor(editor, text, shouldSend) {
  setEditorValue(editor, text);
  editor.focus();
  if (!shouldSend) return { ok: true, sent: false, pending: false };

  await delay(5000);
  const chatRoot = editor.closest(".chat-container, .dialog-container, .chat-dialog") || document;
  const sendButton = await waitForButton(["发送"], 3000, chatRoot);
  if (sendButton) {
    sendButton.click();
  } else {
    editor.focus();
    const keyOptions = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    editor.dispatchEvent(new KeyboardEvent("keydown", keyOptions));
    editor.dispatchEvent(new KeyboardEvent("keypress", keyOptions));
    editor.dispatchEvent(new KeyboardEvent("keyup", keyOptions));
  }
  return { ok: true, sent: true, pending: false };
}

function firstElement(selectors, root = document) {
  for (const selector of selectors) {
    const element = root.querySelector(selector);
    if (element) return element;
  }
  return null;
}

function firstVisible(selectors, root = document) {
  for (const selector of selectors) {
    const elements = [...root.querySelectorAll(selector)];
    const element = elements.find((item) => item.getClientRects().length && !item.disabled);
    if (element) return element;
  }
  return null;
}

function textOf(root, selectors) {
  return firstElement(selectors, root)?.innerText?.trim() || "";
}

function inferHeading(root) {
  return [...root.querySelectorAll("h1, h2, h3")].map((el) => el.innerText.trim()).find(Boolean) || "";
}

function inferDescription(root) {
  const blocks = [...root.querySelectorAll("section, div")]
    .map((el) => el.innerText?.trim() || "")
    .filter((text) => text.includes("职位描述") || text.includes("任职要求"));
  return blocks.sort((a, b) => a.length - b.length).find((text) => text.length > 80) || "";
}

function inferCity(primary, allText) {
  const source = primary || allText || "";
  return source.match(/(?:北京|上海|天津|重庆|深圳|广州|杭州|成都|武汉|西安|南京|苏州|长沙|郑州|青岛|厦门|合肥|昆明|宁波|东莞)/)?.[0] || "";
}

function parseSalary(value) {
  const match = String(value).match(/(\d+(?:\.\d+)?)\s*[-–~]\s*(\d+(?:\.\d+)?)\s*[Kk]/);
  return match ? { min: Number(match[1]), max: Number(match[2]) } : { min: null, max: null };
}

function stableId(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `local-${(hash >>> 0).toString(16)}`;
}

function uniqueElements(elements) {
  return [...new Set(elements)].filter((element) => element.getClientRects().length);
}

function waitForJobDetail(title, previousJobId, timeout) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const check = () => {
      try {
        const job = extractCurrentJob();
        const expected = normalizeJobTitle(title);
        const actual = normalizeJobTitle(job.title);
        const titleMatches = expected === actual || expected.includes(actual) || actual.includes(expected);
        const changed = !previousJobId || job.jobId !== previousJobId;
        if (titleMatches && (changed || Date.now() - startedAt > 600)) return resolve(job);
      } catch {
        // The detail pane is loading.
      }
      if (Date.now() - startedAt >= timeout) return reject(new Error("等待岗位详情加载超时"));
      setTimeout(check, 250);
    };
    check();
  });
}

function normalizeJobTitle(value) {
  return String(value || "").toLowerCase().replace(/[\s·•()（）【】\[\]_-]/g, "");
}

function findButton(labels, root = document) {
  const candidates = [...root.querySelectorAll("button, a, [role='button']")];
  return candidates.find((element) => {
    const text = element.innerText?.trim() || "";
    return element.getClientRects().length && !element.disabled && labels.some((label) => text === label || text.includes(label));
  });
}

function waitForButton(labels, timeout, root = document) {
  return new Promise((resolve) => {
    const existing = findButton(labels, root);
    if (existing) return resolve(existing);
    const observer = new MutationObserver(() => {
      const element = findButton(labels, root);
      if (element) {
        observer.disconnect();
        resolve(element);
      }
    });
    observer.observe(root === document ? document.documentElement : root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["disabled", "class"]
    });
    setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeout);
  });
}

function setEditorValue(editor, value) {
  if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor), "value")?.set;
    setter ? setter.call(editor, value) : (editor.value = value);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    editor.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  editor.focus();
  document.execCommand("selectAll", false, null);
  const inserted = document.execCommand("insertText", false, value);
  if (!inserted || editor.textContent?.trim() !== value) editor.textContent = value;
  editor.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: value }));
  editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  editor.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Process" }));
}

function waitForVisible(selectors, timeout) {
  return new Promise((resolve) => {
    const existing = firstVisible(selectors);
    if (existing) return resolve(existing);
    const observer = new MutationObserver(() => {
      const element = firstVisible(selectors);
      if (element) {
        observer.disconnect();
        resolve(element);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeout);
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
