const params = new URLSearchParams(location.search);
const reportId = params.get("id");
const { deliveryReports = [] } = await chrome.storage.local.get("deliveryReports");
const report = deliveryReports.find((item) => item.id === reportId);

if (!report) {
  document.getElementById("review").textContent = "未找到本轮投递报告。";
} else {
  document.getElementById("processed").textContent = report.processed;
  document.getElementById("applied").textContent = report.applied;
  document.getElementById("skipped").textContent = report.skipped;
  document.getElementById("failed").textContent = report.failed;
  const modeLabels = { scheduled: "BOSS 定时投递", manual: "BOSS 手动启动", zhilian: "智联手动启动", scheduled_zhilian: "智联定时投递" };
  document.getElementById("mode").textContent = modeLabels[report.mode] || "自动投递";
  document.getElementById("period").textContent = `${formatTime(report.startedAt)} 至 ${formatTime(report.endedAt)}`;
  const rate = report.processed ? Math.round((report.applied / report.processed) * 100) : 0;
  document.getElementById("review").textContent = `${report.stopped ? "本轮由用户停止。" : "本轮已完成全部可加载岗位。"} 共处理 ${report.processed} 个岗位，成功投递 ${report.applied} 个，投递率 ${rate}%，跳过 ${report.skipped} 个，失败 ${report.failed} 个。`;
  document.getElementById("empty").hidden = report.jobs.length > 0;
  document.getElementById("jobs").replaceChildren(...report.jobs.map(renderJob));
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
  article.append(heading, content);
  return article;
}

function formatTime(value) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}
