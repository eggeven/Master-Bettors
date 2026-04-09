const leaderName = document.getElementById("leaderName");
const leaderScore = document.getElementById("leaderScore");
const summaryGrid = document.getElementById("summaryGrid");
const standingsBody = document.getElementById("standingsBody");
const teamGrid = document.getElementById("teamGrid");
const refreshSeconds = document.getElementById("refreshSeconds");
const lastUpdated = document.getElementById("lastUpdated");
const sourceLink = document.getElementById("sourceLink");
const teamTemplate = document.getElementById("teamTemplate");

let refreshTimer = null;
let countdownTimer = null;

async function loadScoreboard() {
  clearError();

  try {
    const response = await fetch("/api/scoreboard", { cache: "no-store" });
    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(data.error || "Could not load scoreboard.");
    }

    render(data);
    scheduleRefresh(data.refreshSeconds || 60);
  } catch (error) {
    showError(error.message);
    scheduleRefresh(60);
  }
}

function render(data) {
  sourceLink.href = data.sourceUrl;
  refreshSeconds.textContent = String(data.refreshSeconds || 60);
  lastUpdated.textContent = new Date(data.fetchedAt).toLocaleString();

  leaderName.textContent = data.leader?.owner || "—";
  leaderScore.textContent = data.leader?.scoreDisplay || "—";
  leaderScore.className = `leader-score ${scoreClass(data.leader?.score ?? 0)}`;

  renderSummary(data);
  renderStandings(data.teams);
  renderTeams(data.teams);
}

function renderSummary(data) {
  const pills = [
    { label: "Teams", value: data.teams.length },
    { label: "Players parsed", value: data.playersFound },
    { label: "Scoring", value: `Best ${data.scoring.count_best_of} of ${data.scoring.team_size}` }
  ];

  summaryGrid.innerHTML = pills.map((pill) => `
    <div class="summary-pill">
      <span>${pill.label}</span>
      <strong>${pill.value}</strong>
    </div>
  `).join("");
}

function renderStandings(teams) {
  standingsBody.innerHTML = teams.map((team, index) => {
    const counting = team.players.filter((player) => player.isCounting).map((player) => player.officialName).join(", ");
    const dropped = team.players.filter((player) => player.isDropped).map((player) => player.officialName).join(", ") || "—";
    return `
      <tr>
        <td>${index + 1}</td>
        <td>${escapeHtml(team.owner)}</td>
        <td class="${scoreClass(team.score)}">${team.scoreDisplay}</td>
        <td>${escapeHtml(counting)}</td>
        <td>${escapeHtml(dropped)}</td>
      </tr>
    `;
  }).join("");
}

function renderTeams(teams) {
  teamGrid.innerHTML = "";

  teams.forEach((team, index) => {
    const fragment = teamTemplate.content.cloneNode(true);
    fragment.querySelector(".team-rank").textContent = `Rank #${index + 1}`;
    fragment.querySelector(".team-owner").textContent = team.owner;
    const total = fragment.querySelector(".team-total");
    total.textContent = team.scoreDisplay;
    total.classList.add(scoreClass(team.score));

    const rows = fragment.querySelector(".team-rows");
    rows.innerHTML = team.players.map((player) => `
      <tr>
        <td>
          <div class="player-name">${escapeHtml(player.officialName)}</div>
          <div class="player-meta">
            ${player.matched ? "" : '<span class="miss-badge">match check</span>'}
            ${player.isCounting ? '<span class="counting-badge">counting</span>' : ""}
            ${player.isDropped ? '<span class="dropped-badge">dropped</span>' : ""}
          </div>
        </td>
        <td>${escapeHtml(player.position || "—")}</td>
        <td class="${scoreClass(player.todayToPar)}">${escapeHtml(player.todayDisplay)}</td>
        <td class="${scoreClass(player.totalToPar)}">${escapeHtml(player.totalDisplay)}</td>
        <td>${escapeHtml(player.thru || player.status || "—")}</td>
      </tr>
    `).join("");

    teamGrid.appendChild(fragment);
  });
}

function scheduleRefresh(seconds) {
  clearTimeout(refreshTimer);
  clearInterval(countdownTimer);

  let remaining = seconds;
  refreshSeconds.textContent = String(remaining);

  countdownTimer = setInterval(() => {
    remaining -= 1;
    refreshSeconds.textContent = String(Math.max(remaining, 0));
  }, 1000);

  refreshTimer = setTimeout(loadScoreboard, seconds * 1000);
}

function showError(message) {
  let box = document.querySelector(".error-box");
  if (!box) {
    box = document.createElement("div");
    box.className = "error-box";
    document.body.insertBefore(box, document.body.firstChild.nextSibling);
  }
  box.textContent = `Live update issue: ${message}`;
}

function clearError() {
  const box = document.querySelector(".error-box");
  if (box) box.remove();
}

function scoreClass(value) {
  if (value === null || value === undefined) return "";
  if (value < 0) return "score-neg";
  if (value > 0) return "score-pos";
  return "score-even";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

loadScoreboard();