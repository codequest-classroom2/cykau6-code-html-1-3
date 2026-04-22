const ORG = 'codequest-classroom2';

// ── raw.githubusercontent.com fetch ──────────────────────────────────────────
// Serves directly from git with no rate limits (unlike api.github.com which
// caps unauthenticated requests at 60/hour per IP — a classroom killer).
// ?t=timestamp busts the browser cache so every call gets the latest version.
async function fetchFresh(username, filename) {
    const url = `https://raw.githubusercontent.com/${ORG}/${username}/main/${filename}?t=${Date.now()}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${filename} failed: ${res.status}`);
    return res.json();
}

// ── Render ───────────────────────────────────────────────────────────────────
function renderTree(pathConfig, data, username) {
    const student  = data.student;
    const progress = data.progress;

    document.getElementById('student-name').textContent = `${student.name}'s Coding Quest 🚀`;
    document.getElementById('xp').textContent      = progress.xp || 0;
    document.getElementById('badges').textContent  = progress.badges?.length || 0;

    const completedMissions = progress.completedMissions || [];
    const unlockedMissions  = progress.unlockedMissions  || [];

    let html = '';
    for (const level of pathConfig.levels) {
        const isLevelUnlocked = (progress.xp || 0) >= level.pointsToUnlock;
        html += `<div class="level ${isLevelUnlocked ? '' : 'locked-level'}">`;
        html += `<h2>${level.emoji} ${level.name} ${level.emoji}</h2>`;
        html += `<div class="level-description">${level.description}</div>`;
        html += `<div class="missions-row">`;

        level.missions.forEach((mission, index) => {
            const missionId     = typeof mission === 'string' ? mission : mission.id;
            const missionName   = typeof mission === 'string' ? mission : mission.name;
            const missionPoints = typeof mission === 'object'  ? mission.points : level.pointsPerMission;
            const missionNumber = typeof mission === 'object'  ? mission.number : index + 1;
            const repoName      = `${username}-${missionId}`;

            const isCompleted = completedMissions.some(m => m.id === missionId);
            // Available only when the repo has actually been created (tracked in unlockedMissions)
            const isUnlocked  = unlockedMissions.includes(missionId);
            let status = 'locked';
            if (isCompleted)     status = 'completed';
            else if (isUnlocked) status = 'available';

            html += `
                <div class="mission-circle ${status}" data-repo="${repoName}">
                    <div class="circle">
                        <span class="circle-number">${missionNumber}</span>
                        <span class="circle-points">${missionPoints} pts</span>
                    </div>
                    <span class="mission-name">${missionName}</span>
                    <div class="status-icon">${status === 'completed' ? '✅' : status === 'available' ? '✨' : '🔒'}</div>
                </div>
            `;
            if (index < level.missions.length - 1) html += `<div class="connector">➡️</div>`;
        });

        html += `</div>`;
        html += `<div class="level-progress">🔓 Requires ${level.pointsToUnlock} XP to unlock</div>`;
        html += `</div>`;
        html += `<div class="connector-large">⬇️</div>`;
    }

    document.getElementById('skill-tree').innerHTML = html;

    document.querySelectorAll('.mission-circle.available, .mission-circle.completed').forEach(circle => {
        circle.addEventListener('click', function () {
            window.open(`https://github.com/${ORG}/${this.dataset.repo}`, '_blank');
        });
    });
}

// ── Main Load ────────────────────────────────────────────────────────────────
async function loadStudentProgress(isManualRefresh = false) {
    let username;
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const config = await (await fetch('./config.json', { signal: controller.signal })).json();
        clearTimeout(timeout);
        username = config.username;
    } catch (err) {
        document.getElementById('student-name').textContent = 'Error loading profile';
        document.getElementById('skill-tree').innerHTML =
            `<h2>Could not load config.json — please refresh the page.</h2>`;
        return;
    }

    const cacheKey = `cq_progress_${username}`;
    const pathKey  = 'cq_webdev';

    // ── localStorage: show stale data instantly while fresh fetch runs ────────
    // On a manual refresh we still want to show the current data while loading.
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
        try {
            const { pathConfig, data } = JSON.parse(cached);
            renderTree(pathConfig, data, username);
        } catch (_) {}
    }

    const btn = document.getElementById('refresh-btn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳'; }

    try {
        // web-dev.json is static (same for every student, never changes at runtime).
        // Cache it in localStorage permanently; only re-fetch on a manual refresh.
        let pathConfig;
        const cachedPath = isManualRefresh ? null : localStorage.getItem(pathKey);
        if (cachedPath) {
            pathConfig = JSON.parse(cachedPath);
        } else {
            const pathRes = await fetch(
                `https://raw.githubusercontent.com/${ORG}/${username}/main/web-dev.json?t=${Date.now()}`
            );
            if (!pathRes.ok) throw new Error('Path config not found');
            pathConfig = await pathRes.json();
            localStorage.setItem(pathKey, JSON.stringify(pathConfig));
        }

        // progress.json — SHA trick guarantees we always get the latest version
        const data = await fetchFresh(username, 'progress.json');

        // Save fresh data so next page load shows it instantly
        localStorage.setItem(cacheKey, JSON.stringify({ pathConfig, data }));
        renderTree(pathConfig, data, username);

    } catch (error) {
        console.error('Error loading progress:', error);
        if (!cached) {
            document.getElementById('skill-tree').innerHTML =
                `<h2>Complete your first mission to unlock your tree! 🚀</h2>`;
        }
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🔄 Refresh'; }
    }
}

// Initial load
loadStudentProgress();

// Auto-refresh every 30 seconds to catch passing grades
setInterval(loadStudentProgress, 30000);
