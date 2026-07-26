const params = new URLSearchParams(location.search);
const reportId = params.get("id");
const { deliveryReports = [] } = await chrome.storage.local.get("deliveryReports");
const report = deliveryReports.find((item) => item.id === reportId);
const detailDialog = document.getElementById("jobDetailDialog");
let retryableFailures = [];
document.getElementById("closeDialog").addEventListener("click", () => detailDialog.close());

if (!report) {
  document.getElementById("review").textContent = "未找到本轮投递报告。";
} else {
  document.getElementById("processed").textContent = report.processed;
  document.getElementById("applied").textContent = report.applied;
  document.getElementById("skipped").textContent = report.skipped;
  const failures = (report.failures || []).filter((item) => item.stage !== "搜索");
  retryableFailures = failures.filter((item) => item.keyword && (item.url || item.jobTitle));
  const failedCount = failures.length;
  document.getElementById("failed").textContent = failedCount;
  const modeLabels = { scheduled: "BOSS 定时投递", manual: "BOSS 手动启动", retry: "BOSS 失败岗位重试", zhilian: "智联手动启动", scheduled_zhilian: "智联定时投递", retry_zhilian: "智联失败岗位重试" };
  document.getElementById("mode").textContent = modeLabels[report.mode] || "自动投递";
  document.getElementById("period").textContent = `${formatTime(report.startedAt)} 至 ${formatTime(report.endedAt)}`;
  const rate = report.processed ? Math.round((report.applied / report.processed) * 100) : 0;
  document.getElementById("review").textContent = `${report.stopped ? "本轮由用户停止。" : "本轮已完成全部可加载岗位。"} 共处理 ${report.processed} 个岗位，成功投递 ${report.applied} 个，投递率 ${rate}%，跳过 ${report.skipped} 个，岗位处理失败 ${failedCount} 个。`;
  document.getElementById("empty").hidden = report.jobs.length > 0;
  document.getElementById("jobs").replaceChildren(...report.jobs.map(renderJob));
  document.getElementById("failureEmpty").hidden = failures.length > 0;
  document.getElementById("failures").replaceChildren(...failures.map(renderFailure));
  const retryAll = document.getElementById("retryAllFailures");
  retryAll.hidden = retryableFailures.length === 0;
  retryAll.addEventListener("click", () => launchRetry(retryableFailures));
}

function renderJob(job) {
  const article = document.createElement("article");
  article.className = "job";
  const heading = document.createElement("div");
  heading.className = "job-heading";
  const title = document.createElement("div");
  const h3 = document.createElement("h3");
  h3.textContent = job.jobTitle;
  const company = document.createElement("div");
  company.className = "company";
  company.textContent = job.company;
  title.append(h3, company);
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${job.salary} · 评分 ${job.score}`;
  heading.append(title, meta);
  const content = document.createElement("p");
  content.className = "content";
  content.textContent = job.workSummary;
  const detailButton = document.createElement("button");
  detailButton.type = "button";
  detailButton.className = "detail-button";
  detailButton.textContent = "查看完整岗位 JD";
  detailButton.addEventListener("click", () => openJobDetail(job));
  article.append(heading, content, detailButton);
  return article;
}

function openJobDetail(job) {
  document.getElementById("dialogTitle").textContent = job.jobTitle || "岗位详情";
  document.getElementById("dialogMeta").textContent = [job.company, job.salary, job.score != null ? `评分 ${job.score}` : ""].filter(Boolean).join(" · ");
  document.getElementById("dialogJd").textContent = job.description || job.workSummary || "未保存岗位 JD";
  detailDialog.showModal();
}

function renderFailure(item) {
  const article = document.createElement("article");
  article.className = "failure";
  const title = document.createElement("strong");
  title.textContent = [item.stage, item.jobTitle || item.keyword || "未命名任务"].filter(Boolean).join(" · ");
  const reason = document.createElement("p");
  reason.textContent = item.reason || "未记录具体原因";
  article.append(title, reason);
  if (item.company) {
    const company = document.createElement("small");
    company.textContent = `企业：${item.company}`;
    article.append(company);
  }
  if (item.keyword && (item.url || item.jobTitle)) {
    const actions = document.createElement("div");
    actions.className = "failure-actions";
    if (item.url) {
      const open = document.createElement("button");
      open.type = "button";
      open.className = "retry-button";
      open.textContent = "打开岗位";
      open.addEventListener("click", () => chrome.tabs.create({ url: item.url, active: true }));
      actions.append(open);
    }
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "retry-button";
    retry.textContent = "重试此岗位";
    retry.addEventListener("click", () => launchRetry([item]));
    actions.append(retry);
    article.append(actions);
  }
  return article;
}

async function launchRetry(items) {
  if (!items.length) return;
  const platform = String(report.mode || "").includes("zhilian") ? "zhilian" : "boss";
  await chrome.storage.local.set({
    recruitmentPlatform: platform,
    pendingRetryRun: { id: crypto.randomUUID(), reportId, platform, jobs: items, createdAt: new Date().toISOString() }
  });
  await chrome.windows.create({ url: chrome.runtime.getURL("sidepanel.html?retry=1"), type: "normal", focused: true, width: 460, height: 820 });
}

function formatTime(value) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}
