const ui = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element]));
let currentJob = null;
let currentResult = null;
let autoRun = null;
let autoStarting = false;
let preparingStopRequested = false;
let chatRun = null;
let currentPlatform = "boss";
const flowWaiters = new Map();

ui["open-settings"].addEventListener("click", () => chrome.runtime.openOptionsPage());
ui["analyze-empty"].addEventListener("click", loadAndAnalyze);
ui.analyze.addEventListener("click", analyzeCurrentJob);
ui.fill.addEventListener("click", () => applyGreeting(false));
ui.send.addEventListener("click", () => applyGreeting(true));
ui.skip.addEventListener("click", skipCurrentJob);
ui["auto-toggle"].addEventListener("click", () => {
  toggleAutoApply().catch(async (error) => {
    await logEvent("error", "自动投递按钮处理失败", error);
    showError(error.message);
    ui["auto-progress"].textContent = `启动失败：${error.message}`;
  });
});
ui["debug-log-toggle"].addEventListener("click", toggleDebugLog);
ui["debug-log-export"].addEventListener("click", exportDebugLog);
ui["debug-log-clear"].addEventListener("click", clearDebugLog);
ui["schedule-start"].addEventListener("click", scheduleAutoApply);
ui["schedule-cancel"].addEventListener("click", cancelScheduledAutoApply);
ui["process-chat"].addEventListener("click", toggleChatProcessing);
ui["platform-boss"].addEventListener("click", () => setPlatform("boss"));
ui["platform-zhilian"].addEventListener("click", () => setPlatform("zhilian"));

window.addEventListener("error", (event) => logEvent("error", "侧边栏脚本错误", event.error || event.message));
window.addEventListener("unhandledrejection", (event) => logEvent("error", "未处理的异步错误", event.reason));

chrome.tabs.onActivated.addListener(() => {
  if (!autoRun && !autoStarting && !chatRun) refreshJob();
});
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.active && !autoRun && !autoStarting && !chatRun) refreshJob();
});
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "JOB_PAGE_CHANGED" && !autoRun && !autoStarting && !chatRun) refreshJob();
  if (message?.type === "GREETING_FLOW_STAGE") {
    logEvent(message.level || "info", message.message || "沟通流程更新", message.detail);
  }
  if (message?.type === "STOP_AUTO_RUN" && autoRun?.id === message.runId) {
    stopAutoApply(autoRun);
  }
  if (message?.type === "COMPLETE_GREETING_FLOW" && flowWaiters.has(message.jobId)) {
    flowWaiters.get(message.jobId)(message.status);
    flowWaiters.delete(message.jobId);
  }
});

initialize();

async function initialize() {
  const { recruitmentPlatform = "boss" } = await chrome.storage.local.get("recruitmentPlatform");
  await setPlatform(recruitmentPlatform, false);
  await Promise.all([refreshJob(), renderSchedule(), renderActiveRunState()]);
  if (new URLSearchParams(location.search).get("scheduled") === "1") {
    await logEvent("info", "系统定时任务已触发", { systemTime: new Date().toLocaleString("zh-CN", { hour12: false }) });
    await startAutoApply(true);
  }
}

async function setPlatform(platform, persist = true) {
  if (autoRun || autoStarting || chatRun) {
    showError("请先停止当前任务再切换招聘平台");
    return;
  }
  currentPlatform = platform === "zhilian" ? "zhilian" : "boss";
  ui["platform-boss"].classList.toggle("active", currentPlatform === "boss");
  ui["platform-zhilian"].classList.toggle("active", currentPlatform === "zhilian");
  ui["platform-boss"].setAttribute("aria-pressed", String(currentPlatform === "boss"));
  ui["platform-zhilian"].setAttribute("aria-pressed", String(currentPlatform === "zhilian"));
  ui["process-chat"].classList.toggle("hidden", currentPlatform !== "boss");
  ui["automation-title"].textContent = currentPlatform === "boss" ? "BOSS 自动投递" : "智联自动投递";
  ui["search-keywords"].textContent = currentPlatform === "boss"
    ? "启动后将按简历生成搜索关键词"
    : "智联模式：只筛选评分并点击立即投递，不发送消息";
  if (persist) await chrome.storage.local.set({ recruitmentPlatform: currentPlatform });
  await refreshJob();
}

async function getBossTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.url?.startsWith("https://www.zhipin.com/web/geek/")) return active;
  const [bossTab] = await chrome.tabs.query({ url: "https://www.zhipin.com/web/geek/*" });
  return bossTab;
}

async function getBossJobsTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.url?.startsWith("https://www.zhipin.com/web/geek/jobs")) return active;
  const [bossTab] = await chrome.tabs.query({ url: "https://www.zhipin.com/web/geek/jobs*" });
  return bossTab;
}

async function ensureBossJobsTab() {
  const existing = await getBossJobsTab();
  if (existing) return existing;
  const [bossTab] = await chrome.tabs.query({ url: "https://www.zhipin.com/web/geek/*" });
  if (!bossTab) return null;
  await logEvent("info", "BOSS 标签页当前不在职位列表，正在返回职位页", { tabId: bossTab.id, from: bossTab.url });
  return navigateAndWait(bossTab.id, "https://www.zhipin.com/web/geek/jobs");
}

async function getZhilianTab() {
  const patterns = ["https://www.zhaopin.com/*", "https://sou.zhaopin.com/*"];
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.url && /https:\/\/(?:www|sou)\.zhaopin\.com\//.test(active.url)) return active;
  for (const url of patterns) {
    const [tab] = await chrome.tabs.query({ url });
    if (tab) return tab;
  }
  return null;
}

async function refreshJob() {
  clearError();
  try {
    if (currentPlatform === "zhilian") {
      const tab = await getZhilianTab();
      if (!tab) throw new Error("请先打开智联招聘职位搜索页面");
      currentJob = null;
      show(ui["empty-state"]);
      hide(ui["job-card"]);
      hide(ui.result);
      ui.status.textContent = "智联模式已就绪";
      ui["empty-state"].querySelector("p").textContent = "点击开始后将搜索、打开详情、评分并直接投递。";
      ui["analyze-empty"].classList.add("hidden");
      return;
    }
    ui["empty-state"].querySelector("p").textContent = "打开 BOSS 职位列表，在左侧选择岗位。";
    ui["analyze-empty"].classList.remove("hidden");
    const tab = await getBossJobsTab();
    if (!tab) throw new Error("请先打开 BOSS 直聘职位页面");
    await refreshSearchContext(tab);
    const response = await sendToBossTab(tab, { type: "GET_CURRENT_JOB" });
    if (!response?.ok) throw new Error(response?.error || "无法读取岗位");
    currentJob = response.job;
    currentResult = null;
    renderJob();
  } catch (error) {
    currentJob = null;
    show(ui["empty-state"]);
    hide(ui["job-card"]);
    hide(ui.result);
    ui.status.textContent = "等待岗位页面";
    showError(error.message);
  }
}

async function loadAndAnalyze() {
  await refreshJob();
  if (currentJob) await analyzeCurrentJob();
}

function renderJob() {
  hide(ui["empty-state"]);
  show(ui["job-card"]);
  hide(ui.result);
  ui["job-title"].textContent = currentJob.title;
  ui["job-meta"].textContent = [currentJob.company, currentJob.salary, currentJob.city].filter(Boolean).join(" · ");
  ui.status.textContent = "已读取当前岗位";
  const jobId = currentJob.jobId;
  chrome.storage.local.get("history").then(({ history = {} }) => {
    ui["history-badge"].classList.toggle("hidden", !history[jobId]);
  });
}

async function analyzeCurrentJob() {
  if (!currentJob) return refreshJob();
  clearError();
  hide(ui.result);
  show(ui.loading);
  ui.analyze.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: "ANALYZE_JOB", job: currentJob });
    if (!response?.ok) throw new Error(response?.error || "岗位分析失败");
    currentResult = response.result;
    renderResult();
  } catch (error) {
    showError(error.message);
  } finally {
    hide(ui.loading);
    ui.analyze.disabled = false;
  }
}

async function renderResult() {
  const labels = { apply: "建议沟通", caution: "谨慎考虑", skip: "建议跳过" };
  ui.score.textContent = currentResult.score;
  ui.recommendation.textContent = labels[currentResult.recommendation] || "待判断";
  ui.summary.textContent = currentResult.summary;
  renderList(ui.strengths, currentResult.matchedStrengths, "未发现明确优势");
  renderList(ui.concerns, currentResult.concerns, "暂无明显风险");
  ui.greeting.value = currentResult.greeting;
  const { settings = {} } = await chrome.storage.local.get("settings");
  ui.send.classList.toggle("hidden", !settings.autoSend);
  show(ui.result);
  ui.status.textContent = `分析完成，匹配分 ${currentResult.score}`;
}

async function applyGreeting(send) {
  clearError();
  try {
    const tab = await getBossJobsTab();
    if (!tab) throw new Error("未找到 BOSS 职位页面");
    const response = await sendToBossTab(tab, {
      type: "FILL_GREETING",
      text: ui.greeting.value,
      send,
      jobId: currentJob.jobId
    });
    if (!response?.ok) throw new Error(response?.error || "填写失败");
    await saveHistory(response.pending ? (send ? "pending_send" : "pending_fill") : (send ? "sent" : "filled"));
    ui.status.textContent = response.pending
      ? "已进入沟通流程，正在等待消息页"
      : send ? "已点击发送" : "已填入，请在页面确认发送";
  } catch (error) {
    showError(error.message);
  }
}

async function skipCurrentJob() {
  await saveHistory("skipped");
  ui.status.textContent = "已标记跳过";
  show(ui["history-badge"]);
}

async function saveHistory(status) {
  if (!currentJob) return;
  return saveHistoryForJob(currentJob, currentResult, status, ui.greeting.value || "");
}

async function saveHistoryForJob(job, result, status, greeting = "") {
  await chrome.runtime.sendMessage({
    type: "SAVE_HISTORY",
    entry: {
      jobId: job.jobId,
      title: job.title,
      company: job.company,
      url: job.url,
      salary: job.salary || "",
      status,
      score: result?.score ?? null,
      greeting
    }
  });
}

async function toggleAutoApply() {
  await logEvent("info", "点击自动投递按钮", {
    platform: currentPlatform,
    autoStarting,
    localRun: autoRun?.id || null,
    buttonText: ui["auto-toggle"].textContent
  });
  if (autoRun) {
    await logEvent("warn", "检测到当前页面任务，执行停止", { runId: autoRun.id });
    await stopAutoApply(autoRun);
    return;
  }
  if (autoStarting) {
    preparingStopRequested = true;
    ui["auto-progress"].textContent = "正在停止准备流程...";
    return;
  }
  const { activeAutoRun } = await chrome.storage.local.get("activeAutoRun");
  if (activeAutoRun?.runId) {
    if (isStoredRunStale(activeAutoRun)) {
      await chrome.storage.local.remove("activeAutoRun");
      await logEvent("warn", "启动前清理失联任务锁", activeAutoRun);
      return startAutoApply();
    }
    await logEvent("warn", "检测到其他页面正在运行任务，执行后台停止", activeAutoRun);
    ui["auto-toggle"].disabled = true;
    ui["auto-progress"].textContent = "正在停止后台投递任务...";
    const response = await chrome.runtime.sendMessage({ type: "REQUEST_STOP_AUTO_RUN" });
    if (!response?.ok) {
      await chrome.storage.local.remove("activeAutoRun");
      showError(response?.error || "后台任务已不存在，已清理残留状态");
    }
    ui["auto-progress"].textContent = "后台投递任务已停止";
    ui["auto-toggle"].disabled = false;
    await renderActiveRunState();
    return;
  }
  await startAutoApply();
}

async function toggleChatProcessing() {
  if (chatRun) {
    chatRun.stopped = true;
    chatRun.waitResolvers.splice(0).forEach((resolve) => resolve());
    ui["chat-progress"].textContent = "正在停止聊天处理...";
    ui["process-chat"].textContent = "消息";
    return;
  }
  await startChatProcessing();
}

async function startChatProcessing(options = {}) {
  const scanOnce = Boolean(options.scanOnce);
  const run = { stopped: false, processed: 0, replied: 0, skipped: 0, failed: 0, waitResolvers: [] };
  chatRun = run;
  show(ui["chat-status-panel"]);
  ui["process-chat"].textContent = "停止";
  try {
    const { settings = {} } = await chrome.storage.local.get("settings");
    if (!settings.apiKey || !settings.model) throw new Error("请先完成 AI 接口设置");
    const tab = await getBossTab();
    if (!tab) throw new Error("未找到 BOSS 页面");
    if (scanOnce) await focusSourcePage(tab);
    await sendToBossTab(tab, { type: "OPEN_MESSAGES" }).catch(() => {});
    await delayForChat(run, 1800);
    while (!run.stopped) {
      const threadsResponse = await sendToBossTab(tab, { type: "GET_CHAT_THREADS" });
      if (!threadsResponse?.ok) throw new Error(threadsResponse?.error || "读取聊天会话失败");
      const thread = (threadsResponse.threads || []).find((item) => item.needsReply && run[`done_${item.key}`] !== item.preview);
      if (!thread) {
        if (scanOnce) {
          run.emptyPolls = (run.emptyPolls || 0) + 1;
          if (run.emptyPolls < 3) {
            ui["chat-progress"].textContent = "正在确认消息列表和未回复会话...";
            await delayForChat(run, 1200);
            continue;
          }
          ui["chat-progress"].textContent = `消息审查完成：检查 ${run.processed} 个会话，暂无待回复消息`;
          break;
        }
        ui["chat-progress"].textContent = `已检查 ${run.processed} 个会话，等待新消息...`;
        await delayForChat(run, 5000);
        continue;
      }
      run.emptyPolls = 0;
      run[`done_${thread.key}`] = thread.preview;
      const followUpKey = `${thread.recruiter}|${thread.company}`;
      if (thread.followUpCandidate) {
        const { chatFollowUps = {} } = await chrome.storage.local.get("chatFollowUps");
        if (chatFollowUps[followUpKey]) {
          run.skipped += 1;
          continue;
        }
      }
      ui["chat-progress"].textContent = `正在处理：${thread.recruiter} · ${thread.company}`;
      try {
        const selected = await sendToBossTab(tab, { type: "SELECT_CHAT_THREAD", thread });
        if (!selected?.ok) throw new Error(selected?.error || "选择会话失败");
        const contextResponse = await sendToBossTab(tab, { type: "GET_CHAT_CONTEXT" });
        if (!contextResponse?.ok) throw new Error(contextResponse?.error || "读取聊天上下文失败");
        const generated = await chrome.runtime.sendMessage({ type: "GENERATE_CHAT_REPLY", context: {
          ...contextResponse.context,
          recruiter: thread.recruiter,
          company: thread.company,
          jobTitle: contextResponse.context.jobTitle || "",
          threadPreview: thread.preview,
          followUpMode: Boolean(thread.followUpCandidate),
          hoursSinceLastMessage: thread.hoursSince
        }});
        if (!generated?.ok) throw new Error(generated?.error || "生成聊天回复失败");
        const result = generated.result;
        await renderChatContext(contextResponse.context, thread, result);
        await logEvent("info", "聊天回复决策", {
          recruiter: thread.recruiter,
          action: result.action,
          questionType: result.questionType,
          sendResume: result.sendResume,
          confidence: result.confidence,
          rationale: result.rationale
        });
        if (result.action === "no_reply" || !result.reply || result.confidence < 70) {
          run.skipped += 1;
        } else {
          const reply = await sendToBossTab(tab, { type: "SEND_CHAT_REPLY", text: result.reply, send: Boolean(settings.chatAutoSend) });
          if (!reply?.ok) throw new Error(reply?.error || "填写聊天回复失败");
          if (settings.chatAutoSend) run.replied += 1;
          if (settings.chatAutoSend && thread.followUpCandidate) {
            const { chatFollowUps = {} } = await chrome.storage.local.get("chatFollowUps");
            chatFollowUps[followUpKey] = new Date().toISOString();
            await chrome.storage.local.set({ chatFollowUps });
          }
          if (settings.chatAutoSend && result.sendResume && settings.chatSendResume) await sendToBossTab(tab, { type: "SEND_RESUME" });
          if (!settings.chatAutoSend) {
            run.stopped = true;
            ui["chat-progress"].textContent = "回复已填入，请检查发送；审核模式本轮暂停";
          }
        }
      } catch (error) {
        run.failed += 1;
        await logEvent("error", `聊天会话处理失败：${thread.recruiter}`, error);
      } finally {
        run.processed += 1;
      }
      await delayForChat(run, (Number(settings.chatReplyIntervalSeconds) || 8) * 1000);
    }
  } catch (error) {
    await logEvent("error", "聊天任务失败", error);
    showError(error.message);
  } finally {
    if (!scanOnce || run.stopped) ui["chat-progress"].textContent = `已停止：检查 ${run.processed}，回复 ${run.replied}，失败 ${run.failed}`;
    ui["process-chat"].textContent = "消息";
    chatRun = null;
  }
}

function delayForChat(run, milliseconds) {
  if (run.stopped) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      const index = run.waitResolvers.indexOf(finish);
      if (index >= 0) run.waitResolvers.splice(index, 1);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    run.waitResolvers.push(finish);
  });
}

async function renderChatContext(context, thread, result) {
  const { applicationArchives = [] } = await chrome.storage.local.get("applicationArchives");
  const normalize = (value) => String(value || "").toLowerCase().replace(/[\s·•()（）【】\[\]_-]/g, "");
  const archive = applicationArchives.find((item) => (
    normalize(item.company) === normalize(context.company || thread.company)
    && normalize(item.jobTitle) === normalize(context.jobTitle)
  ));
  show(ui["chat-context"]);
  ui["chat-context-title"].textContent = context.jobTitle || archive?.jobTitle || "当前聊天岗位";
  ui["chat-context-meta"].textContent = [context.company || archive?.company || thread.company, archive?.salary, archive?.score != null ? `原匹配分 ${archive.score}` : ""].filter(Boolean).join(" · ");
  ui["chat-context-description"].textContent = archive?.description
    ? `${archive.description.replace(/\s+/g, " ").slice(0, 180)}${archive.description.length > 180 ? "..." : ""}`
    : "未匹配到该岗位的投递档案，将仅使用简历和沟通知识库。";
  ui["chat-context-decision"].textContent = `策略：${result.action} · ${result.questionType} · 置信度 ${result.confidence}${result.sendResume ? " · 建议发送简历" : ""}`;
}

async function startZhilianAutoApply(scheduled = false) {
  clearError();
  let run = null;
  autoStarting = true;
  preparingStopRequested = false;
  ui["auto-toggle"].textContent = "停止";
  ui["auto-toggle"].classList.replace("primary", "danger");
  try {
    const { settings = {} } = await chrome.storage.local.get("settings");
    if (!settings.autoSend) throw new Error("请先在设置中开启“允许直接发送和自动投递”");
    if (!settings.apiKey || !settings.model) throw new Error("请先完成 AI 接口设置");
    const tab = await getZhilianTab();
    if (!tab) throw new Error("请先打开智联招聘职位搜索页面");
    if (preparingStopRequested) throw new Error("用户已停止自动投递");
    const cachedKeywords = settings.precomputedSearchKeywords || [];
    if (!cachedKeywords.length) throw new Error("尚未配置岗位搜索切片，请在设置页点击“根据简历生成”并保存");
    ui["search-keywords"].textContent = `智联将搜索：${cachedKeywords.join("、")}`;
    run = {
      id: crypto.randomUUID(), stopped: false, tabId: tab.id, searchUrl: tab.url,
      keywords: cachedKeywords, processed: 0, applied: 0, skipped: 0, failed: 0,
      communicationTab: null, completion: null, waitResolvers: [],
      startedAt: new Date().toISOString(), mode: scheduled ? "scheduled_zhilian" : "zhilian", appliedJobs: [], failedJobs: []
    };
    autoRun = run;
    autoStarting = false;
    await startRunHeartbeat(run);
    await logEvent("info", "智联自动投递启动", { keywords: run.keywords, messageEnabled: false, chatEnabled: false });
    await runZhilianQueue(settings, run, tab);
  } catch (error) {
    await logEvent("error", "智联自动投递失败", error);
    showError(error.message);
  } finally {
    const summary = run ? `完成 ${run.processed}，投递 ${run.applied}，跳过 ${run.skipped}，失败 ${run.failed}` : "智联自动投递未启动";
    ui["auto-progress"].textContent = summary;
    if (run) {
      stopRunHeartbeat(run);
      const { activeAutoRun } = await chrome.storage.local.get("activeAutoRun");
      if (activeAutoRun?.runId === run.id) await chrome.storage.local.remove("activeAutoRun");
      await openRunReport(run, summary).catch((error) => logEvent("error", "打开智联投递简报失败", error));
    }
    if (autoRun === run) autoRun = null;
    autoStarting = false;
    ui["auto-toggle"].disabled = false;
    ui["auto-toggle"].textContent = "开始";
    ui["auto-toggle"].classList.replace("danger", "primary");
    if (scheduled) {
      const currentTab = await chrome.tabs.getCurrent();
      if (currentTab?.id) await chrome.tabs.remove(currentTab.id).catch(() => {});
    }
  }
}

async function runZhilianQueue(settings, run, tab) {
  const seen = new Set();
  for (const keyword of run.keywords) {
    if (run.stopped) break;
    try {
      ui["auto-progress"].textContent = `智联正在搜索：${keyword}`;
      const search = await searchZhilianJobsAndRead(tab, keyword);
      if (search?.verificationRequired) {
        await waitForZhilianVerification(tab, run);
        if (run.stopped) break;
        tab = await navigateAndWait(tab.id, run.searchUrl);
        const retriedSearch = await searchZhilianJobsAndRead(tab, keyword);
        if (!retriedSearch?.ok) throw new Error(retriedSearch?.error || `验证后重新搜索“${keyword}”失败`);
        search.jobs = retriedSearch.jobs;
        search.ok = true;
      }
      if (!search?.ok) throw new Error(search?.error || `搜索“${keyword}”失败`);
      let jobs = search.jobs || [];
      let currentPage = 1;
      while (!run.stopped) {
        const queuedJob = jobs.find((job) => !seen.has(jobIdentity(job)));
        if (queuedJob) {
          seen.add(jobIdentity(queuedJob));
          await processZhilianJob(tab, queuedJob, settings, run, keyword);
          if (run.stopped) break;
          await delayForRun(run, (Number(settings.autoApplyIntervalSeconds) || 8) * 1000);
          const refreshed = await sendToBossTab(tab, { type: "GET_ZHILIAN_JOB_LIST" });
          jobs = refreshed?.jobs || [];
          continue;
        }
        ui["auto-progress"].textContent = `智联第 ${currentPage} 页已处理，正在打开下一页...`;
        let nextPage = await nextZhilianPageAndRead(tab, currentPage);
        if (nextPage?.verificationRequired) {
          await waitForZhilianVerification(tab, run);
          if (run.stopped) break;
          tab = await navigateAndWait(tab.id, run.searchUrl);
          const restarted = await searchZhilianJobsAndRead(tab, keyword);
          if (!restarted?.ok) throw new Error(restarted?.error || "验证后恢复智联分页失败");
          jobs = restarted.jobs || [];
          currentPage = 1;
          continue;
        }
        if (!nextPage?.ok) throw new Error(nextPage?.error || "智联切换下一页失败");
        if (!nextPage.hasNext) {
          await logEvent("info", "智联当前关键词全部页码处理完成", { keyword, lastPage: currentPage });
          break;
        }
        jobs = nextPage.jobs || [];
        currentPage = nextPage.currentPage || currentPage + 1;
        await logEvent("info", "智联已进入下一页", { keyword, currentPage, jobs: jobs.length });
      }
    } catch (error) {
      if (run.stopped) break;
      await logEvent("warn", `智联岗位搜索未产生可处理结果：${keyword}`, error);
    }
  }
}

async function nextZhilianPageAndRead(tab, previousPage) {
  try {
    return await sendToBossTab(tab, { type: "NEXT_ZHILIAN_PAGE" });
  } catch (error) {
    if (!/message port|Receiving end|context invalidated|tab was closed/i.test(String(error?.message || error))) throw error;
    await delay(2500);
    const currentTab = await chrome.tabs.get(tab.id);
    const [list, pagination] = await Promise.all([
      sendToBossTab(currentTab, { type: "GET_ZHILIAN_JOB_LIST" }),
      sendToBossTab(currentTab, { type: "GET_ZHILIAN_PAGINATION" })
    ]);
    const advanced = pagination?.currentPage == null || pagination.currentPage !== previousPage;
    return {
      ok: Boolean(list?.ok && pagination?.ok),
      hasNext: advanced,
      jobs: list?.jobs || [],
      currentPage: pagination?.currentPage || previousPage + 1,
      canAdvance: pagination?.canAdvance
    };
  }
}

async function searchZhilianJobsAndRead(tab, keyword) {
  try {
    return await sendToBossTab(tab, { type: "SEARCH_ZHILIAN_JOBS", keyword });
  } catch (error) {
    if (!/message port|Receiving end|context invalidated/i.test(String(error?.message || error))) throw error;
    await delay(2500);
    return sendToBossTab(await chrome.tabs.get(tab.id), { type: "GET_ZHILIAN_JOB_LIST" });
  }
}

async function processZhilianJob(sourceTab, queuedJob, settings, run, keyword) {
  ui["auto-progress"].textContent = `智联第 ${run.processed + 1} 个 · ${keyword}：${queuedJob.title}`;
  let detailTab = null;
  try {
    if (queuedJob.applied) {
      run.skipped += 1;
      ui["auto-progress"].textContent = `已跳过智联已投递岗位：${queuedJob.title}`;
      await logEvent("info", "跳过智联已投递岗位", { title: queuedJob.title, company: queuedJob.company });
      return;
    }
    const { applicationWhitelist = [] } = await chrome.storage.local.get("applicationWhitelist");
    if (applicationWhitelist.some((entry) => whitelistMatchesJob(entry, queuedJob))) {
      run.skipped += 1;
      ui["auto-progress"].textContent = `已跳过智联白名单岗位：${queuedJob.title}`;
      await logEvent("info", "跳过智联白名单岗位", { title: queuedJob.title, company: queuedJob.company });
      return;
    }
    detailTab = await openZhilianDetailTab(sourceTab, queuedJob);
    run.communicationTab = detailTab;
    await chrome.windows.update(sourceTab.windowId, { focused: true }).catch(() => {});
    await chrome.tabs.update(detailTab.id, { active: true }).catch(() => {});
    await logEvent("info", "已打开智联岗位详情页", { title: queuedJob.title, tabId: detailTab.id, url: queuedJob.url });
    detailTab = await waitForTabComplete(detailTab.id, 15000);
    const detailResult = await readZhilianDetailWithVerification(detailTab, queuedJob.url, run);
    detailTab = detailResult.tab;
    const detail = detailResult.response;
    if (!detail?.ok) throw new Error(detail?.error || "读取智联岗位详情失败");
    const job = {
      ...detail.job,
      company: chooseCompanyName(detail.job.company, queuedJob.company),
      title: queuedJob.title || detail.job.title,
      salary: detail.job.salary || queuedJob.salary
    };
    const analyzed = await chrome.runtime.sendMessage({ type: "ANALYZE_JOB", job, runId: run.id });
    if (run.stopped) return;
    if (!analyzed?.ok) throw new Error(analyzed?.error || "智联岗位分析失败");
    const result = analyzed.result;
    const shouldApply = result.recommendation === "apply" && result.score >= settings.minimumScore;
    if (!shouldApply) {
      await saveHistoryForJob(job, result, "skipped_auto", "");
      run.skipped += 1;
      return;
    }
    const applied = await sendToBossTab(detailTab, { type: "APPLY_ZHILIAN_JOB" });
    if (!applied?.ok) throw new Error(applied?.error || "智联立即投递失败");
    if (!applied.applied && applied.already) {
      run.skipped += 1;
      return;
    }
    await saveHistoryForJob(job, result, "sent", "");
    const finalized = await chrome.runtime.sendMessage({
      type: "FINALIZE_APPLICATION_RECORD",
      record: { job, result, greeting: "" }
    });
    if (!finalized?.ok) throw new Error(finalized?.error || "智联投递成功但岗位归档失败");
    run.applied += 1;
    run.appliedJobs.push({ company: job.company, jobTitle: job.title, salary: job.salary || queuedJob.salary || "未识别", workSummary: summarizeWorkContent(job.description), description: cleanJobDescription(job.description), score: result.score, url: job.url });
    await logEvent("info", "智联岗位投递完成", { title: job.title, company: job.company, score: result.score });
  } catch (error) {
    if (!run.stopped) {
      run.failed += 1;
      run.failedJobs.push({ stage: "岗位处理", jobTitle: queuedJob.title, company: queuedJob.company, keyword, reason: error.message || String(error) });
      await logEvent("error", `智联岗位处理失败：${queuedJob.title}`, error);
    }
  } finally {
    if (detailTab?.id) await chrome.tabs.remove(detailTab.id).catch(() => {});
    run.communicationTab = null;
    await focusSourcePage(sourceTab);
    run.processed += 1;
  }
}

async function openZhilianDetailTab(sourceTab, job) {
  const before = new Set((await chrome.tabs.query({ windowId: sourceTab.windowId })).map((tab) => tab.id));
  const clicked = await sendToBossTab(sourceTab, { type: "OPEN_ZHILIAN_JOB", job }).catch(() => null);
  if (clicked?.ok) {
    const opened = await waitForCreatedTab(sourceTab.windowId, before, job.url, 4000);
    if (opened) return opened;
  }
  await logEvent("warn", "智联岗位链接点击未产生新标签，回退到 Chrome API", { title: job.title, url: job.url });
  return chrome.tabs.create({ url: job.url, active: true, openerTabId: sourceTab.id });
}

async function waitForCreatedTab(windowId, before, expectedUrl, timeout) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const tabs = await chrome.tabs.query({ windowId });
    const tab = tabs.find((item) => !before.has(item.id) && (!expectedUrl || item.pendingUrl === expectedUrl || item.url === expectedUrl || !item.url));
    if (tab) return tab;
    await delay(200);
  }
  return null;
}

async function readZhilianDetailWithVerification(tab, jobUrl, run) {
  let currentTab = tab;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await sendToBossTab(currentTab, { type: "GET_ZHILIAN_JOB_DETAIL" });
    if (response?.ok) return { tab: currentTab, response };
    if (!response?.verificationRequired) return { tab: currentTab, response };
    await waitForZhilianVerification(currentTab, run);
    if (run.stopped) return { tab: currentTab, response: { ok: false, error: "用户已停止" } };
    currentTab = await navigateAndWait(currentTab.id, jobUrl);
    await delayForRun(run, 1200);
  }
  return { tab: currentTab, response: { ok: false, error: "智联人机验证重复触发，请稍后再试" } };
}

async function waitForZhilianVerification(tab, run) {
  ui["auto-progress"].textContent = "智联触发人机验证：请在打开的页面手动勾选“确认您是真人”";
  await logEvent("warn", "智联触发人机验证，自动投递已暂停等待手动完成", { tabId: tab.id, url: tab.url });
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
  while (!run.stopped) {
    await delayForRun(run, 2000);
    if (run.stopped) return;
    const current = await chrome.tabs.get(tab.id).catch(() => null);
    if (!current) throw new Error("验证页面已关闭，无法继续智联投递");
    try {
      const state = await sendToBossTab(current, { type: "CHECK_ZHILIAN_VERIFICATION" });
      if (state?.ok && !state.verificationRequired) {
        await logEvent("info", "智联人机验证已完成，恢复自动投递", { tabId: tab.id });
        ui["auto-progress"].textContent = "验证完成，正在恢复当前岗位...";
        return;
      }
    } catch {
      // The page may be redirecting after manual verification.
    }
  }
}

async function startAutoApply(scheduled = false) {
  if (currentPlatform === "zhilian") return startZhilianAutoApply(scheduled);
  clearError();
  let run = null;
  autoStarting = true;
  preparingStopRequested = false;
  ui["auto-toggle"].disabled = false;
  ui["auto-toggle"].textContent = "停止";
  ui["auto-toggle"].classList.replace("primary", "danger");
  try {
    ui["auto-progress"].textContent = "启动 1/6：正在读取插件设置...";
    await logEvent("info", "BOSS 启动 1/6：读取设置", { scheduled });
    const { settings = {}, history = {} } = await chrome.storage.local.get(["settings", "history"]);
    if (!settings.autoSend) throw new Error("请先在设置中开启“允许直接发送和自动投递”");
    if (!settings.apiKey || !settings.model) throw new Error("请先完成 AI 接口验证并保存模型");
    ui["auto-progress"].textContent = "启动 2/6：正在定位 BOSS 职位页面...";
    await logEvent("info", "BOSS 启动 2/6：定位职位标签页");
    const tab = await ensureBossJobsTab();
    if (!tab) throw new Error("请先打开 BOSS 直聘职位列表页面");
    await logEvent("info", "BOSS 职位标签页已就绪", { tabId: tab.id, url: tab.url });
    ui["auto-progress"].textContent = "启动 3/5：正在识别当前推荐岗位...";
    const context = await sendToBossTab(tab, { type: "GET_SEARCH_CONTEXT" });
    if (!context?.ok) throw new Error(context?.error || "无法识别 BOSS 推荐岗位");
    await logEvent("info", "BOSS 启动 3/6：推荐岗位识别完成", context);
    if (preparingStopRequested) throw new Error("用户已停止自动投递");
    const cachedKeywords = settings.precomputedSearchKeywords || [];
    if (!cachedKeywords.length) throw new Error("尚未配置岗位搜索切片，请在设置页点击“根据简历生成”并保存");
    await logEvent("info", "BOSS 启动 4/5：已读取预生成岗位切片", { count: cachedKeywords.length, keywords: cachedKeywords });
    ui["current-role"].textContent = context?.currentRole || "未识别";
    ui["search-keywords"].textContent = `将搜索：${cachedKeywords.join("、")}`;

    run = {
      id: crypto.randomUUID(),
      stopped: false,
      tabId: tab.id,
      searchUrl: tab.url,
      keywords: cachedKeywords,
      keywordSlices: settings.precomputedSearchSlices || [],
      processed: 0,
      applied: 0,
      skipped: 0,
      failed: 0,
      history,
      communicationTab: null,
      completion: null,
      waitResolvers: [],
      startedAt: new Date().toISOString(),
      mode: scheduled ? "scheduled" : "manual",
      appliedJobs: [],
      failedJobs: []
    };
    autoRun = run;
    autoStarting = false;
    ui["auto-progress"].textContent = "启动 4/5：正在创建自动投递队列...";
    await startRunHeartbeat(run);
    await logEvent("info", "自动投递启动", {
      role: context?.currentRole || "未识别",
      keywordCount: run.keywords.length,
      slices: run.keywordSlices,
      limit: "无限制，滚动至没有新岗位"
    });
    ui["auto-toggle"].textContent = "停止";
    ui["auto-toggle"].disabled = false;
    ui["auto-toggle"].classList.replace("primary", "danger");
    ui["auto-progress"].textContent = "启动 5/5：队列已创建，开始搜索第一个关键词...";
    await logEvent("info", "BOSS 启动 5/5：自动投递队列开始", { runId: run.id, firstKeyword: run.keywords[0] });
    await runAutoQueue(settings, run);
  } catch (error) {
    await logEvent("error", "自动投递启动或运行失败", error);
    ui["auto-progress"].textContent = `启动失败：${error.message}`;
    showError(error.message);
  } finally {
    const summary = run
      ? `完成 ${run.processed}，投递 ${run.applied}，跳过 ${run.skipped}，失败 ${run.failed}`
      : "自动投递未启动";
    await logEvent("info", "自动投递结束", summary);
    ui["auto-progress"].textContent = summary;
    if (run) {
      stopRunHeartbeat(run);
      const { activeAutoRun } = await chrome.storage.local.get("activeAutoRun");
      if (activeAutoRun?.runId === run.id) await chrome.storage.local.remove("activeAutoRun");
      await openRunReport(run, summary).catch((error) => logEvent("error", "打开投递简报失败", error));
    }
    if (autoRun === run) autoRun = null;
    autoStarting = false;
    ui["auto-toggle"].disabled = false;
    ui["auto-toggle"].textContent = "开始";
    ui["auto-toggle"].classList.replace("danger", "primary");
    if (run && !run.stopped && currentPlatform === "boss") {
      await startPostDeliveryChatReview(run).catch((error) => logEvent("error", "投递后消息审查启动失败", error));
    }
    if (scheduled) {
      const currentTab = await chrome.tabs.getCurrent();
      if (currentTab?.id) await chrome.tabs.remove(currentTab.id).catch(() => {});
    }
  }
}

async function stopAutoApply(run) {
  if (!run || run.stopped) return;
  run.stopped = true;
  ui["auto-toggle"].disabled = true;
  ui["auto-progress"].textContent = "正在停止并清理沟通窗口...";
  run.waitResolvers.splice(0).forEach((resolve) => resolve());
  run.completion?.cancel();
  if (run.communicationTab?.id) await chrome.tabs.remove(run.communicationTab.id).catch(() => {});
  const sourceTab = await chrome.tabs.get(run.tabId).catch(() => null);
  if (sourceTab) await sendToBossTab(sourceTab, { type: "CANCEL_PAGE_AUTOMATION" }).catch(() => {});
  await chrome.runtime.sendMessage({ type: "CANCEL_AUTO_RUN", runId: run.id }).catch(() => {});
  await logEvent("warn", "用户停止自动投递", { processed: run.processed, applied: run.applied });
}

async function startRunHeartbeat(run) {
  const write = async () => {
    const { activeAutoRun } = await chrome.storage.local.get("activeAutoRun");
    if (activeAutoRun?.runId && activeAutoRun.runId !== run.id) return;
    await chrome.storage.local.set({
      activeAutoRun: { runId: run.id, mode: run.mode, startedAt: run.startedAt, heartbeatAt: Date.now() }
    });
  };
  await write();
  run.heartbeatTimer = setInterval(() => write().catch(() => {}), 10000);
}

function stopRunHeartbeat(run) {
  if (run?.heartbeatTimer) clearInterval(run.heartbeatTimer);
  run.heartbeatTimer = null;
}

async function runAutoQueue(settings, run) {
  const seen = new Set();
  for (const keyword of run.keywords) {
    if (run.stopped) break;
    try {
      const tab = await restoreJobListTab(run);
      ui["auto-progress"].textContent = `正在搜索：${keyword}`;
      await logEvent("info", "开始搜索", { keyword, tabId: tab.id });
      const search = await searchJobsAndRead(tab, keyword);
      if (!search?.ok) throw new Error(search?.error || `搜索“${keyword}”失败`);
      if (!search.jobs?.length) {
        await logEvent("error", `搜索“${keyword}”后读取到 0 个岗位`, search.diagnostics || "页面未返回诊断信息");
        throw new Error(`搜索“${keyword}”后读取到 0 个岗位，详细 DOM 信息已写入日志`);
      }
      await logEvent("info", "搜索结果已读取", { keyword, count: search.jobs.length });
      let batch = search.jobs;
      let unchangedScrolls = 0;
      while (!run.stopped && unchangedScrolls < 8) {
        const queuedJob = batch.find((job) => !seen.has(jobIdentity(job)));
        if (queuedJob) {
          seen.add(jobIdentity(queuedJob));
          await processAutoJob(tab, queuedJob, settings, keyword, run);
          if (run.stopped) break;
          await delayForRun(run, (Number(settings.autoApplyIntervalSeconds) || 8) * 1000);
          if (run.stopped) break;
          const refreshed = await sendToBossTab(tab, { type: "GET_JOB_LIST" });
          if (!refreshed?.ok) throw new Error(refreshed?.error || "重新读取岗位列表失败");
          batch = refreshed.jobs || [];
          continue;
        }
        ui["auto-progress"].textContent = `已处理 ${run.processed} 个岗位，正在向下加载更多...`;
        const more = await sendToBossTab(tab, { type: "LOAD_MORE_JOBS" });
        if (!more?.ok) throw new Error(more?.error || "向下加载岗位失败");
        batch = more.jobs || [];
        const newCount = batch.filter((job) => !seen.has(jobIdentity(job))).length;
        unchangedScrolls = newCount ? 0 : unchangedScrolls + 1;
        await logEvent("info", "滚动加载岗位", {
          keyword,
          visible: batch.length,
          newJobs: newCount,
          unchangedScrolls,
          scroll: more.scroll || null
        });
      }
      if (!run.stopped) await logEvent("info", "当前岗位名称已完成全部可加载结果", { keyword, processed: run.processed, unchangedScrolls });
    } catch (error) {
      await logEvent("warn", `岗位搜索未产生可处理结果：${keyword}`, error);
    }
  }
}

async function startPostDeliveryChatReview(run) {
  ui["auto-progress"].textContent = `投递结束，正在进入消息并审查未回复会话...`;
  await logEvent("info", "开始投递后消息审查", { applied: run.applied, processed: run.processed });
  await startChatProcessing({ scanOnce: true });
}

async function processAutoJob(tab, queuedJob, settings, keyword, run) {
  ui["auto-progress"].textContent = `第 ${run.processed + 1} 个 · ${keyword}：${queuedJob.title}`;
  await logEvent("info", "开始处理岗位", queuedJob);
  let completion = null;
  let communicationTab = null;
  let stagedJobId = null;
  try {
      const selected = await sendToBossTab(tab, { type: "SELECT_JOB", job: queuedJob });
      if (!selected?.ok) throw new Error(selected?.error || "选择岗位失败");
      await logEvent("info", "左侧岗位已选中", { requested: queuedJob.title, loaded: selected.title, jobId: selected.jobId });
      const detail = await sendToBossTab(tab, { type: "GET_CURRENT_JOB" });
      if (!detail?.ok) throw new Error(detail?.error || "读取岗位详情失败");
      const job = detail.job;
      currentJob = job;
      renderJob();

      const latest = await chrome.storage.local.get(["history", "applicationWhitelist"]);
      const whitelistEntry = (latest.applicationWhitelist || []).find((entry) => (
        whitelistMatchesJob(entry, queuedJob) || whitelistMatchesJob(entry, job)
      ));
      if (whitelistEntry) {
        run.skipped += 1;
        await logEvent("info", "跳过投递白名单岗位", { title: job.title, company: job.company, expectedSalary: whitelistEntry.expectedSalary });
        return;
      }
      const previousStatus = latest.history?.[job.jobId]?.status;
      const terminalStatuses = new Set(["sent", "filled", "skipped", "skipped_auto"]);
      if (terminalStatuses.has(previousStatus)) {
        run.skipped += 1;
        await logEvent("info", "跳过已有历史岗位", { title: job.title, jobId: job.jobId, status: previousStatus });
        return;
      }
      if (previousStatus) await logEvent("info", "重试未完成的历史岗位", { title: job.title, jobId: job.jobId, status: previousStatus });

      if (run.stopped) return;
      const analyzed = await chrome.runtime.sendMessage({ type: "ANALYZE_JOB", job, runId: run.id });
      if (run.stopped) return;
      if (!analyzed?.ok) throw new Error(analyzed?.error || "AI 分析失败");
      const result = analyzed.result;
      const greeting = result.greeting;
      currentJob = job;
      currentResult = result;
      await logEvent("info", "岗位分析完成", {
        title: job.title,
        recruiter: job.recruiter,
        recruiterActivity: job.recruiterActivity || "未识别",
        score: result.score,
        recommendation: result.recommendation,
        concerns: result.concerns
      });
      await renderResult();

      const shouldApply = result.recommendation === "apply" && result.score >= settings.minimumScore;
      if (!shouldApply) {
        await saveHistoryForJob(job, result, "skipped_auto", greeting);
        run.skipped += 1;
      } else {
        const archiveJob = {
          ...job,
          company: chooseCompanyName(job.company, queuedJob.company),
          title: queuedJob.title || job.title,
          salary: job.salary || queuedJob.salary
        };
        const staged = await chrome.runtime.sendMessage({
          type: "STAGE_APPLICATION_RECORD",
          record: { job: archiveJob, result, greeting }
        });
        if (!staged?.ok) throw new Error(staged?.error || "暂存岗位归档失败");
        stagedJobId = archiveJob.jobId;
        await logEvent("info", "岗位达到投递条件，打开沟通小窗", {
          title: job.title,
          score: result.score,
          minimumScore: settings.minimumScore
        });
        communicationTab = await createCommunicationWindow(tab, queuedJob.url || job.url, run);
        run.communicationTab = communicationTab;
        completion = waitForGreetingFlow(job.jobId, 60000);
        run.completion = completion;
        const response = await sendToBossTab(communicationTab, {
          type: "FILL_GREETING",
          text: greeting,
          send: true,
          jobId: job.jobId,
          closeTab: true,
          closeTabId: communicationTab.id
        });
        if (!response?.ok) {
          throw new Error(response?.error || "启动沟通失败");
        }
        await saveHistoryForJob(job, result, response.pending ? "pending_send" : "sent", greeting);
        if (response.pending) await completion.promise;
        else {
          completion.cancel();
          completion = null;
          await chrome.tabs.remove(communicationTab.id).catch(() => {});
        }
        await focusSourcePage(tab);
        run.communicationTab = null;
        run.completion = null;
        run.applied += 1;
        run.appliedJobs.push({
          company: chooseCompanyName(job.company, queuedJob.company),
          jobTitle: queuedJob.title || job.title,
          salary: job.salary || queuedJob.salary || "未识别",
          workSummary: summarizeWorkContent(job.description),
          description: cleanJobDescription(job.description),
          score: result.score,
          url: queuedJob.url || job.url
        });
        const finalized = await chrome.runtime.sendMessage({
          type: "FINALIZE_APPLICATION_RECORD",
          record: { job: archiveJob, result, greeting }
        });
        if (!finalized?.ok) throw new Error(finalized?.error || "投递成功但岗位归档失败");
        stagedJobId = null;
        await logEvent("info", "招呼语发送完成", { title: job.title, jobId: job.jobId });
      }
    } catch (error) {
      completion?.cancel();
      if (stagedJobId) await chrome.runtime.sendMessage({ type: "CLEAR_STAGED_APPLICATION", jobId: stagedJobId }).catch(() => {});
      if (communicationTab?.id) await chrome.tabs.remove(communicationTab.id).catch(() => {});
      run.communicationTab = null;
      run.completion = null;
      await focusSourcePage(tab);
      if (run.stopped) return;
      run.failed += 1;
      run.failedJobs.push({ stage: "岗位处理", jobTitle: queuedJob.title, company: queuedJob.company, keyword, reason: error.message || String(error) });
      await logEvent("error", `岗位处理失败：${queuedJob.title}`, error);
      showError(`${queuedJob.title}：${error.message}`);
    } finally {
      run.processed += 1;
    }
}

function delayForRun(run, milliseconds) {
  if (run.stopped) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      const index = run.waitResolvers.indexOf(finish);
      if (index >= 0) run.waitResolvers.splice(index, 1);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    run.waitResolvers.push(finish);
  });
}

function jobIdentity(job) {
  return job.url || `${job.title}|${job.company}`;
}

function whitelistMatchesJob(entry, job) {
  return normalizeWhitelistText(entry.company) === normalizeWhitelistText(job.company)
    && normalizeWhitelistText(entry.jobTitle) === normalizeWhitelistText(job.title);
}

function normalizeWhitelistText(value) {
  return String(value || "").toLowerCase().replace(/[\s·•()（）【】\[\]_-]/g, "");
}

function summarizeWorkContent(description) {
  const text = cleanJobDescription(description).replace(/\s+/g, " ").trim();
  return text ? `${text.slice(0, 220)}${text.length > 220 ? "..." : ""}` : "未识别到工作内容";
}

function cleanJobDescription(value) {
  const lines = String(value || "").replace(/\r/g, "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const noise = /^(?:举报|微信扫码分享|扫码分享|分享至微信|分享|收藏|职位发布者|职位发布于|安全提示|求职安全提示|温馨提示)$/;
  while (lines.length && (noise.test(lines[0]) || /^(?:举报|微信扫码|扫码分享)/.test(lines[0]))) lines.shift();
  const firstContent = lines.findIndex((line) => /职位描述|岗位职责|工作职责|任职要求|岗位要求|工作内容|职位要求/.test(line));
  return (firstContent > 0 ? lines.slice(firstContent) : lines).filter((line) => !noise.test(line)).join("\n").trim();
}

function chooseCompanyName(detailCompany, cardCompany) {
  const valid = (value) => {
    const text = String(value || "").trim();
    return text && !/^(?:北京|上海|天津|重庆|深圳|广州|杭州|成都|武汉|西安|南京|苏州|长沙|郑州|青岛|厦门|合肥|昆明|宁波|东莞)(?:市|市区|地区)?(?:[·\s-].*)?$/.test(text);
  };
  return valid(detailCompany) ? detailCompany.trim() : valid(cardCompany) ? cardCompany.trim() : "企业名称未识别";
}

async function openRunReport(run, summary) {
  const reportableFailures = (run.failedJobs || []).filter((item) => item.stage !== "搜索");
  const report = {
    id: crypto.randomUUID(),
    mode: run.mode,
    startedAt: run.startedAt,
    endedAt: new Date().toISOString(),
    stopped: run.stopped,
    summary,
    processed: run.processed,
    applied: run.applied,
    skipped: run.skipped,
    failed: reportableFailures.length,
    jobs: run.appliedJobs,
    failures: reportableFailures
  };
  const { deliveryReports = [] } = await chrome.storage.local.get("deliveryReports");
  await chrome.storage.local.set({ deliveryReports: [...deliveryReports, report].slice(-30) });
  await chrome.windows.create({
    url: chrome.runtime.getURL(`report.html?id=${encodeURIComponent(report.id)}`),
    type: "popup",
    focused: true,
    width: 820,
    height: 720
  });
}

async function searchJobsAndRead(tab, keyword) {
  try {
    return await sendToBossTab(tab, { type: "SEARCH_JOBS", keyword });
  } catch (error) {
    const message = String(error?.message || error);
    await logEvent("warn", "搜索导致页面连接中断，等待重连", { keyword, error: message });
    if (!/message port|Receiving end|context invalidated|tab was closed/i.test(message)) throw error;
    await delay(2500);
    const currentTab = await chrome.tabs.get(tab.id);
    const response = await sendToBossTab(currentTab, { type: "GET_JOB_LIST" });
    return response?.ok ? { ...response, keyword } : response;
  }
}

async function createCommunicationWindow(sourceTab, url, run) {
  const popup = await chrome.windows.create({
    url,
    type: "popup",
    focused: true,
    width: 1100,
    height: 800
  });
  const tab = popup.tabs?.[0];
  if (!tab?.id) throw new Error("沟通小窗创建失败");
  run.communicationTab = tab;
  return waitForTabComplete(tab.id, 15000);
}

async function focusSourcePage(tab) {
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
}

function waitForTabComplete(tabId, timeout) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") finish(tab);
    }).catch(() => {});
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.tabs.onRemoved.removeListener(removedListener);
      reject(new Error("打开沟通标签页超时"));
    }, timeout);
    let settled = false;
    const finish = (tab) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.tabs.onRemoved.removeListener(removedListener);
      setTimeout(() => resolve(tab), 800);
    };
    const listener = (updatedId, changeInfo, tab) => {
      if (updatedId === tabId && changeInfo.status === "complete") {
        finish(tab);
      }
    };
    const removedListener = (removedId) => {
      if (removedId !== tabId || settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.tabs.onRemoved.removeListener(removedListener);
      reject(new Error("沟通窗口已关闭"));
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.onRemoved.addListener(removedListener);
  });
}

async function refreshSearchContext(tab) {
  const response = await sendToBossTab(tab, { type: "GET_SEARCH_CONTEXT" });
  ui["current-role"].textContent = response?.currentRole || "未识别";
}

async function scheduleAutoApply() {
  clearError();
  const timestamp = new Date(ui["schedule-time"].value).getTime();
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
    showError("请选择晚于当前系统时间的定时时间");
    return;
  }
  const response = await chrome.runtime.sendMessage({ type: "SCHEDULE_AUTO_APPLY", when: timestamp });
  if (!response?.ok) {
    showError(response?.error || "设置定时任务失败");
    return;
  }
  await logEvent("info", "已设置定时自动投递", { systemTime: new Date(timestamp).toLocaleString("zh-CN", { hour12: false }) });
  await renderSchedule();
}

async function cancelScheduledAutoApply() {
  const response = await chrome.runtime.sendMessage({ type: "CANCEL_SCHEDULED_AUTO_APPLY" });
  if (!response?.ok) {
    showError(response?.error || "取消定时任务失败");
    return;
  }
  ui["schedule-time"].value = "";
  await logEvent("info", "已取消定时自动投递");
  await renderSchedule();
}

async function renderSchedule() {
  const { scheduledAutoApplyAt } = await chrome.storage.local.get("scheduledAutoApplyAt");
  const timestamp = Number(scheduledAutoApplyAt);
  if (Number.isFinite(timestamp) && timestamp > Date.now()) {
    const date = new Date(timestamp);
    ui["schedule-time"].value = toLocalDateTimeValue(date);
    ui["schedule-status"].textContent = `将在系统时间 ${date.toLocaleString("zh-CN", { hour12: false })} 开始`;
    ui["schedule-cancel"].disabled = false;
  } else {
    ui["schedule-status"].textContent = "未设置定时任务";
    ui["schedule-cancel"].disabled = true;
  }
  ui["schedule-time"].min = toLocalDateTimeValue(new Date(Date.now() + 60000));
}

function toLocalDateTimeValue(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function restoreJobListTab(run = autoRun) {
  if (!run) throw new Error("自动投递任务状态已丢失");
  let tab = await chrome.tabs.get(run.tabId);
  if (!tab.url?.startsWith("https://www.zhipin.com/web/geek/jobs")) {
    tab = await navigateAndWait(run.tabId, run.searchUrl);
  }
  return tab;
}

function navigateAndWait(tabId, url) {
  return new Promise(async (resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("返回职位列表超时"));
    }, 15000);
    const listener = (updatedId, changeInfo, tab) => {
      if (updatedId === tabId && changeInfo.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(() => resolve(tab), 800);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    await chrome.tabs.update(tabId, { url });
  });
}

function waitForGreetingFlow(jobId, timeout) {
  let timer;
  const promise = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      flowWaiters.delete(jobId);
      reject(new Error("等待消息页发送完成超时"));
    }, timeout);
    flowWaiters.set(jobId, (status) => {
      clearTimeout(timer);
      resolve(status);
    });
  });
  promise.catch(() => {});
  return {
    promise,
    cancel() {
      clearTimeout(timer);
      flowWaiters.delete(jobId);
    }
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function renderList(container, values, fallback) {
  container.replaceChildren(...(values?.length ? values : [fallback]).map((value) => {
    const item = document.createElement("li");
    item.textContent = value;
    return item;
  }));
}

async function sendToBossTab(tab, message) {
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (error) {
    if (!String(error.message).includes("Receiving end does not exist")) throw error;
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["src/content.css"] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["src/content.js"] });
    return chrome.tabs.sendMessage(tab.id, message);
  }
}

async function toggleDebugLog() {
  const opening = ui["debug-log-panel"].classList.contains("hidden");
  ui["debug-log-panel"].classList.toggle("hidden", !opening);
  ui["debug-log-toggle"].textContent = opening ? "收起运行日志" : "查看运行日志";
  if (opening) await renderDebugLog();
}

async function clearDebugLog() {
  await chrome.storage.local.set({ debugLogs: [] });
  await renderDebugLog();
}

async function exportDebugLog() {
  const { debugLogs = [] } = await chrome.storage.local.get("debugLogs");
  const text = debugLogs.length
    ? debugLogs.map((entry) => `[${formatLogTime(entry.time)}] ${String(entry.level).toUpperCase()} ${entry.message}${entry.detail ? `\n${entry.detail}` : ""}`).join("\n\n")
    : "暂无日志";
  const blob = new Blob(["\uFEFF", text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `boss运行日志_${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function logEvent(level, message, detail = null) {
  try {
    const { debugLogs = [] } = await chrome.storage.local.get("debugLogs");
    const entry = {
      time: new Date().toISOString(),
      level,
      message,
      detail: serializeLogDetail(detail)
    };
    const logs = [...debugLogs, entry].slice(-200);
    await chrome.storage.local.set({ debugLogs: logs });
    if (!ui["debug-log-panel"].classList.contains("hidden")) renderDebugLog(logs);
  } catch {
    // Logging must never interrupt the application flow.
  }
}

async function renderDebugLog(logs = null) {
  if (!logs) ({ debugLogs: logs = [] } = await chrome.storage.local.get("debugLogs"));
  ui["debug-log"].textContent = logs.length
    ? logs.map((entry) => `[${formatLogTime(entry.time)}] ${String(entry.level).toUpperCase()} ${entry.message}${entry.detail ? `\n${entry.detail}` : ""}`).join("\n\n")
    : "暂无日志";
  ui["debug-log-panel"].scrollTop = ui["debug-log-panel"].scrollHeight;
}

function serializeLogDetail(value) {
  if (value == null) return "";
  if (value instanceof Error) return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ""}`;
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function formatLogTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

async function renderActiveRunState() {
  if (autoRun || autoStarting) return;
  const { activeAutoRun } = await chrome.storage.local.get("activeAutoRun");
  const heartbeatAt = Number(activeAutoRun?.heartbeatAt || 0);
  const startedAt = new Date(activeAutoRun?.startedAt || 0).getTime();
  const stale = Boolean(activeAutoRun?.runId) && (
    (heartbeatAt && Date.now() - heartbeatAt > 90000)
    || (!heartbeatAt && startedAt && Date.now() - startedAt > 120000)
  );
  if (stale) {
    await chrome.storage.local.remove("activeAutoRun");
    await logEvent("warn", "已自动清理失联的后台投递任务状态", activeAutoRun);
  }
  const active = Boolean(activeAutoRun?.runId && !stale);
  ui["auto-toggle"].textContent = active ? "停止后台任务" : "开始";
  ui["auto-toggle"].classList.toggle("danger", active);
  ui["auto-toggle"].classList.toggle("primary", !active);
  if (active) {
    const label = activeAutoRun.mode === "scheduled" ? "定时投递" : "自动投递";
    ui["auto-progress"].textContent = `${label}正在后台运行`;
  }
}

function isStoredRunStale(activeRun) {
  const heartbeatAt = Number(activeRun?.heartbeatAt || 0);
  const startedAt = new Date(activeRun?.startedAt || 0).getTime();
  return Boolean(activeRun?.runId) && (
    (heartbeatAt && Date.now() - heartbeatAt > 90000)
    || (!heartbeatAt && startedAt && Date.now() - startedAt > 120000)
  );
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.activeAutoRun) renderActiveRunState();
});

function show(element) { element.classList.remove("hidden"); }
function hide(element) { element.classList.add("hidden"); }
function clearError() { hide(ui.error); ui.error.textContent = ""; }
function showError(message) { ui.error.textContent = message; show(ui.error); }
