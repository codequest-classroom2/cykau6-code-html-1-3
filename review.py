import os, json, requests, base64, subprocess
from datetime import datetime

XP_PER_MISSION = 5

def check_mission():
    print("🚀 CodeQuest Reviewer: checking submissions/index.html...")

    with open('mission.json', 'r', encoding='utf-8-sig') as f: mission = json.load(f)
    with open('rubric.json', 'r', encoding='utf-8-sig') as f: rubric = json.load(f)
    with open('identity.json', 'r', encoding='utf-8-sig') as f: identity = json.load(f)

    results = []
    points_earned = 0
    for check in rubric.get('checks', []):
        process = subprocess.run(check['test'], shell=True, capture_output=True)
        passed = (process.returncode == 0)
        results.append({
            "name": check['name'],
            "pass": passed,
            "feedback": "✅" if passed else f"❌ {check['feedback']}"
        })
        if passed: points_earned += 1

    is_passed = points_earned >= rubric.get('passingScore', 1)

    if is_passed:
        already_completed = any(m['id'] == mission['id'] for m in identity.get('completedMissions', []))

        if not already_completed:
            identity['xp'] = identity.get('xp', 0) + XP_PER_MISSION
            if 'completedMissions' not in identity: identity['completedMissions'] = []
            identity['completedMissions'].append({"id": mission['id'], "at": datetime.now().isoformat()})

            sync_to_master(identity)
            check_unlocks(identity, mission['id'])
            sync_to_master(identity)

    write_feedback_file(is_passed, points_earned, results, identity)
    return is_passed

def check_unlocks(identity, completed_mission_id):
    """Unlock the next mission in the same zone, and check if a new zone just unlocked."""
    token = os.environ.get('GH_TOKEN')
    headers = {"Authorization": f"token {token}"}
    res = requests.get(
        "https://api.github.com/repos/codequest-classroom2/codequest-master/contents/paths/web-dev.json",
        headers=headers
    )
    if res.status_code != 200:
        print(f"⚠️ Could not fetch web-dev.json: {res.status_code}")
        return

    path_config = json.loads(base64.b64decode(res.json()['content']))
    if 'unlockedMissions' not in identity:
        identity['unlockedMissions'] = []

    completed_ids = {m['id'] for m in identity.get('completedMissions', [])}

    for level in path_config.get('levels', []):
        missions = level.get('missions', [])
        mission_ids = [m['id'] for m in missions]

        # Sequential within-zone unlock: if the just-completed mission is in this zone,
        # unlock the next one in order
        if completed_mission_id in mission_ids:
            idx = mission_ids.index(completed_mission_id)
            if idx + 1 < len(mission_ids):
                next_id = mission_ids[idx + 1]
                if next_id not in identity['unlockedMissions']:
                    trigger_next_gen(identity, next_id)
                    identity['unlockedMissions'].append(next_id)
                    print(f"🔓 Next mission unlocked: {next_id}")

        # Cross-zone unlock: check if this zone's conditions are now met
        condition = level.get('unlockCondition')
        if condition is None:
            continue  # HTML Basics — always available, no check needed

        xp_ok = identity['xp'] >= condition.get('xp', 0)
        required = condition.get('requiredMissions', [])
        missions_ok = all(r in completed_ids for r in required)

        if xp_ok and missions_ok:
            first_mission = mission_ids[0] if mission_ids else None
            if first_mission and first_mission not in identity['unlockedMissions']:
                trigger_next_gen(identity, first_mission)
                identity['unlockedMissions'].append(first_mission)
                print(f"🔓 Zone '{level['name']}' unlocked — triggering: {first_mission}")

def sync_to_master(identity):
    token = os.environ.get('GH_TOKEN')
    user = identity['username']
    url = f"https://api.github.com/repos/codequest-classroom2/codequest-master/contents/students/{user}.json"
    headers = {"Authorization": f"token {token}"}

    res = requests.get(url, headers=headers)
    sha = None
    existing = {}
    if res.status_code == 200:
        sha = res.json().get('sha')
        try:
            existing = json.loads(base64.b64decode(res.json()['content']))
        except Exception as e:
            print(f"⚠️ Could not decode existing master record: {e}")

    existing.setdefault('student', {})
    existing.setdefault('progress', {})
    existing['student']['name'] = identity['name']
    existing['student']['username'] = user
    existing['progress']['xp'] = identity['xp']
    existing['progress']['completedMissions'] = identity['completedMissions']
    existing['progress']['unlockedMissions'] = identity.get('unlockedMissions', [])
    existing['progress']['badges'] = identity.get('badges', [])
    existing['progress']['currentMission'] = identity.get('currentMission', '')

    put_payload = {
        "message": f"🏆 {user} passed {identity.get('currentMission', 'mission')}",
        "content": base64.b64encode(json.dumps(existing, indent=2).encode()).decode(),
    }
    if sha:
        put_payload["sha"] = sha

    result = requests.put(url, headers=headers, json=put_payload)
    if result.status_code in [200, 201]:
        print(f"✅ Master record updated for {user}")
    else:
        print(f"❌ Failed to update master record: {result.status_code} - {result.text}")

    sync_to_portfolio(identity, existing, headers)

def sync_to_portfolio(identity, master_data, headers):
    user = identity['username']
    url = f"https://api.github.com/repos/codequest-classroom2/{user}/contents/progress.json"

    existing = requests.get(url, headers=headers)
    put_payload = {
        "message": "🏆 Progress update",
        "content": base64.b64encode(json.dumps(master_data, indent=2).encode()).decode()
    }
    if existing.status_code == 200:
        put_payload["sha"] = existing.json().get("sha")

    result = requests.put(url, headers=headers, json=put_payload)
    if result.status_code in [200, 201]:
        print(f"✅ Portfolio progress updated for {user}")
    else:
        print(f"❌ Failed to update portfolio progress: {result.status_code} - {result.text}")

def trigger_next_gen(identity, mission_id):
    token = os.environ.get('GH_TOKEN')
    url = "https://api.github.com/repos/codequest-classroom2/codequest-master/actions/workflows/invite-student.yml/dispatches"
    payload = {
        "ref": "main",
        "inputs": {
            "student_username": identity['username'],
            "student_name": identity['name'],
            "first_mission": mission_id
        }
    }
    result = requests.post(url, headers={"Authorization": f"token {token}"}, json=payload)
    if result.status_code == 204:
        print(f"✅ Next mission triggered: {mission_id}")
    else:
        print(f"❌ Failed to trigger next mission: {result.status_code} - {result.text}")

def write_feedback_file(passed, score, results, identity):
    """Write pass/fail feedback into the ## AI Feedback section of README.md.

    All other README sections are preserved exactly as-is.
    The section is appended when it doesn't already exist.
    """
    import re

    status = "🎉 MISSION PASSED!" if passed else "⚠️ MISSION INCOMPLETE"

    # Pull requirement names from mission.json for richer feedback context
    try:
        with open('mission.json', 'r', encoding='utf-8-sig') as _f:
            _m = json.load(_f)
        reqs = _m.get('requirements', [])
    except Exception:
        reqs = []

    lines = [
        "## AI Feedback\n\n",
        f"**{status}**\n\n",
        f"**Points: {score} | Total XP: {identity['xp']}**\n\n",
        f"*Last reviewed: {datetime.now().strftime('%Y-%m-%d %H:%M UTC')}*\n\n",
        "### Results\n\n",
    ]
    for r in results:
        req_hint = ""
        for req in reqs:
            if r['name'].lower() in req.lower() or req.lower() in r['name'].lower():
                req_hint = f" — *{req}*"
                break
        lines.append(f"- {r['feedback']} **{r['name']}**{req_hint}\n")

    lines.append(f"\n[View your Progress Tree](https://codequest-classroom2.github.io/{identity['username']})\n")

    new_section = "".join(lines)

    try:
        with open('README.md', 'r', encoding='utf-8') as _f:
            content = _f.read()
    except FileNotFoundError:
        content = ""

    # Replace existing AI Feedback section (up to next ## heading or EOF)
    pattern = r'^## AI Feedback\s*\n[\s\S]*?(?=\n## |\Z)'
    if re.search(pattern, content, flags=re.MULTILINE):
        content = re.sub(pattern, new_section.rstrip('\n'), content, flags=re.MULTILINE)
    else:
        content = content.rstrip('\n') + '\n\n---\n\n' + new_section

    with open('README.md', 'w', encoding='utf-8') as _f:
        _f.write(content)

if __name__ == "__main__":
    check_mission()
