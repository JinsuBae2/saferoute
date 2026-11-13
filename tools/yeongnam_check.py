"""선택형 시연 「영남이」의 선정 값을 서버 모형으로 다시 검증한다.

    python -m tools.yeongnam_check            # 기본 실행과 행동 10초 지연
    python -m tools.yeongnam_check --delay 0 5 10 20

쓰는 것은 서버의 실제 코드(ProgressiveFire, calculate_routes, sign_faces)와 화면의 걷기 규칙
(web/src/building/people.ts stepPeople을 옮긴 것, 속도 1.2 m/s)이다. 발화 위치와 단계 시점은
web/src/building/yeongnam.ts에서, 계단 길이는 data/space/wfi-stair-travel-v1.json에서 읽는다.

확인하는 것
- 첫 경로 변경이 불꽃이 아니라 연기로 생기는지(그 시점에 막힌 지점의 불꽃 값 0, 불꽃만 반영하면 더 늦게 바뀜)
- 영남이가 문밖에 서서 마주 보는 유도등 면이 그때 직진에서 우회전으로 바뀌는지, 그 오른쪽 길이 실제 대피 경로인지
- 서 있는 동안 그 자리에서 벽에 가리지 않는 복도 안에 불꽃과 연기가 있는지
- 서 있는 자리(판정상의 자리보다 앞선 화면상의 자리)가 그동안 서버 차단 대상이 아닌지
- 매 순간 영남이가 선 지점·걷는 통로가 그 시점의 서버 차단 대상이 아닌지, 출구에 닿는지
- 다른 인원이 모두 탈출하는지
시험용 확산 모형 위의 확인이다. 실제 연소·피난 시간을 말하지 않는다.
"""
import argparse
import json
import math
import re
import sys
from pathlib import Path

from backend.contracts import parse_contract
from backend.contracts.common import Position
from backend.contracts.messages import BlockedEdge, BlockedNode
from backend.guidance import sign_faces
from backend.progressive_fire import ProgressiveFire, crosses_wall, walls_for
from backend.routing import calculate_routes

ROOT = Path(__file__).resolve().parents[1]
SPEED, DT, HORIZON = 1.2, 0.25, 240


def settings():
    text = (ROOT / "web/src/building/yeongnam.ts").read_text(encoding="utf-8")
    def number(name): return float(re.search(rf"\b{name}: ([0-9.]+),", text).group(1))
    def word(name): return re.search(rf'\b{name}: "([^"]+)"', text).group(1)
    x, y, z = map(float, re.search(r"ignition: \{ x: ([0-9.]+), y: ([0-9.]+), z: ([0-9.]+) \}", text).groups())
    toward = re.search(r"watchToward: \{ x: ([0-9.]+), z: ([0-9.]+) \}", text).groups()
    return dict(start=word("startNodeId"), zone=word("zoneId"), watch=word("watchNodeId"), ahead=word("aheadNodeId"), toward=tuple(map(float, toward)),
                ignition=Position(x=x, y=y, z=z), **{k: number(k) for k in ["panicAt", "listenAt", "departAt", "watchAhead", "lookSeconds"]})


def stand(world, cfg):
    """문밖에 서는 자리: 문 앞 복도 지점에서 다음 갈림길 쪽으로 watchAhead만큼 간 곳. (x, z, 거기까지 걷는 거리)"""
    a, b = world.nodes[cfg["watch"]].position, world.nodes[cfg["ahead"]].position
    ratio = cfg["watchAhead"] / world.length(cfg["watch"], cfg["ahead"])
    return a.x + (b.x - a.x) * ratio, a.z + (b.z - a.z) * ratio, world.length(cfg["start"], cfg["watch"]) + cfg["watchAhead"]


def in_sight(world, cells, x, z, floor):
    """그 자리에서 벽에 가리지 않는 확산 칸 가운데 불꽃이 있는 칸과 연기가 짙은(0.3 이상) 칸의 거리 목록."""
    fire, smoke = [], []
    for c in cells.values():
        if c.floor_id != floor or c.cell_id.startswith(("node:", "edge:")) or (c.fire <= 0 and c.smoke < 0.3): continue
        if any(crosses_wall(Position(x=x, y=0, z=z), Position(x=c.position.x, y=0, z=c.position.z), wall) for wall in world.walls.get(floor, [])): continue
        d = round(math.hypot(c.position.x - x, c.position.z - z), 1)
        if c.fire > 0: fire.append(d)
        if c.smoke >= 0.3: smoke.append(d)
    return sorted(fire), sorted(smoke)


class World:
    def __init__(self):
        self.building = parse_contract("Building", json.loads((ROOT / "data/space/wfi-v1.json").read_text(encoding="utf-8")))
        self.nodes = {n.node_id: n for n in self.building.nodes}
        self.stairs = json.loads((ROOT / "data/space/wfi-stair-travel-v1.json").read_text(encoding="utf-8"))["metres"]
        self.walls = walls_for(self.building.building_id, self.building.building_version)
        self.edges = {}
        for e in self.building.edges:
            for key in [(e.from_node_id, e.to_node_id), (e.to_node_id, e.from_node_id)]: self.edges.setdefault(key, []).append(e.edge_id)
        self.starts = json.loads((ROOT / "data/space/wfi-people-v1.json").read_text(encoding="utf-8"))["start_node_ids"]

    def length(self, a, b):
        if self.nodes[a].floor_id != self.nodes[b].floor_id: return self.stairs[f"{a}>{b}"]
        p, q = self.nodes[a].position, self.nodes[b].position
        return max(math.dist((p.x, p.y, p.z), (q.x, q.y, q.z)), 0.01)

    def routes(self, nodes, edges):
        edges = set(edges) | {e.edge_id for e in self.building.edges if not e.traversable}
        found = calculate_routes(self.building, [BlockedNode(node_id=n, source_ids=[], reason_codes=["ACTIVE_ALARM"]) for n in nodes],
                                 [BlockedEdge(edge_id=e, source_ids=[], reason_codes=["ACTIVE_ALARM"]) for e in edges])
        return {r.node_id: r for r in found}


class Timeline:
    """발화 한 건의 초 단위 서버 상태: 경로, 차단 지점·통로, 유도등 면, 지점별 불·연기."""
    def __init__(self, world, zone, ignition):
        self.world, self.fire = world, ProgressiveFire(world.building)
        self.fire.ignite("manual", zone, ignition, 0)
        assert self.fire.spreads("manual")
        self.states, cache = [], {}
        for second in range(HORIZON + 1):
            spread = self.fire.evaluate(second * 1000)
            if spread.key() not in cache:
                routes = world.routes(spread.nodes, spread.edges)
                faces = {(s.sign_id, f.face_id): f.display for s in world.building.signs for f in sign_faces(s, routes[s.node_id], "EMERGENCY")}
                cache[spread.key()] = (routes, set(spread.nodes), set(spread.edges), faces)
            self.states.append(cache[spread.key()])

    def at(self, t): return self.states[min(int(t), HORIZON)]
    def cells(self, t): return {c.cell_id: c for c in self.fire.evaluate(int(t) * 1000).state.cells}

    def fire_only_routes(self, t):
        hot = {key for key, cell in self.cells(t).items() if cell.fire > 0}
        return self.world.routes([n for n in self.world.nodes if f"node:{n}" in hot], [e for e, points in self.fire.edge_points.items() if any(p in hot for p in points)])


def person(start): return {"from": start, "to": None, "progress": 0.0, "status": "WAITING", "returning": False, "trail": [start]}


def step(world, p, routes, metres):
    """web/src/building/people.ts stepPeople 한 사람분(경보 중, 상태 유효)."""
    if p["status"] == "OUT": return
    budget = metres
    for _ in range(16):
        if p["to"] is None:
            r = routes.get(p["from"])
            if r is None or r.reason_codes: p["status"] = "STUCK"; return
            if r.next_node_id is None: p["status"] = "OUT"; return
            p["to"], p["progress"], p["status"] = r.next_node_id, 0.0, "MOVING"
        g = routes.get(p["to"] if p["returning"] else p["from"])
        lost = g is None or bool(g.reason_codes)
        ahead = None if p["returning"] else routes.get(p["to"])
        if lost and (ahead is None or ahead.reason_codes): p["status"] = "STUCK"; return
        if not lost and not p["returning"] and g.next_node_id is not None and g.next_node_id != p["to"]:
            p["from"], p["to"], p["progress"], p["returning"] = p["to"], p["from"], 1 - p["progress"], True
        p["status"] = "MOVING"
        length = world.length(p["from"], p["to"]); remaining = (1 - p["progress"]) * length
        if budget < remaining: p["progress"] += budget / length; return
        budget -= remaining; p["trail"].append(p["to"])
        p["from"], p["to"], p["progress"], p["returning"] = p["to"], None, 0.0, False


EYE, SIGN_LIFT = 1.6, 30
# 유도등 면이 실제로 걸린 자리(web/src/building/signMount.ts signInstalls). 같은 값인지는 signMount.test.ts가 지킨다.
SIGN_FACES = json.loads((ROOT / "data/space/wfi-sign-install-v1.json").read_text(encoding="utf-8"))["faces"]


def seen_changes(world, before, after, x, z, floor, hx, hz):
    """web/src/building/yeongnam.ts witnessedSignChanges와 같은 기준(실제 면의 자리·방향, 화면 위로 벗어나는 거리, 벽 가림)."""
    out = []
    for sign in world.building.signs:
        node = world.nodes[sign.node_id]
        if node.floor_id != floor: continue
        for face in sign.faces:
            was, now = before[(sign.sign_id, face.face_id)], after[(sign.sign_id, face.face_id)]
            if was is None or now is None or was == now: continue
            place = SIGN_FACES.get(f"{sign.sign_id}/{face.face_id}")
            if place is None: continue  # 달지 않은 면
            px, pz, nx, nz = place["x"], place["z"], place["normal_x"], place["normal_z"]
            too_close = (abs(place["y"] - EYE) + place["tall"] / 2) / math.tan(math.radians(SIGN_LIFT))
            dx, dz = px - x, pz - z; d = math.hypot(dx, dz)
            if not too_close <= d <= 14 or (dx * hx + dz * hz) / d < 0.82 or (-dx * nx - dz * nz) / d < place["facing"]: continue
            if any(crosses_wall(Position(x=x, y=0, z=z), Position(x=px, y=0, z=pz), wall) for wall in world.walls.get(floor, [])): continue
            out.append(f"{sign.sign_id}/{face.face_id} {was}→{now} ({d:.1f} m)")
    return out


def run(world, timeline, cfg, delay=0.0):
    """영남이 한 명. 출발 전에는 문 지점에서 기다리고(화면에서는 문밖 서는 자리에서 남쪽을 본다), 정면 유도등이 바뀌면 잠깐 선다."""
    p, t, hold, exposed, witnessed, trace = person(cfg["start"]), 0.0, 0.0, 0.0, [], []
    depart = cfg["departAt"] + delay
    sx, sz, reach = stand(world, cfg)
    ahead_blocked, phone_at = 0.0, None
    while t < HORIZON and p["status"] != "OUT":
        routes, blocked_nodes, blocked_edges, faces = timeline.at(t)
        # 화면에서는 판정상의 자리가 서는 자리에 닿을 때까지 거기 서 있다(web BuildingScene과 같은 규칙).
        walked = (p["progress"] * world.length(cfg["start"], cfg["watch"]) if p["from"] == cfg["start"] and p["to"] in (None, cfg["watch"])
                  else world.length(cfg["start"], cfg["watch"]) + p["progress"] * world.length(cfg["watch"], cfg["ahead"]) if p["from"] == cfg["watch"] and p["to"] == cfg["ahead"] and not p["returning"]
                  else math.inf)
        staged = walked < reach
        # 서 있는 자리는 문 앞 복도 지점과 다음 갈림길 사이다. 깨어 나와 있는 동안 그 통로와 두 지점이 막히면 안 된다.
        if staged and t >= cfg["panicAt"] + delay and (cfg["watch"] in blocked_nodes or cfg["ahead"] in blocked_nodes or any(e in blocked_edges for e in world.edges.get((cfg["watch"], cfg["ahead"]), []))): ahead_blocked += DT
        if phone_at is None and t >= depart and p["status"] != "OUT" and p["from"] not in (cfg["start"], cfg["watch"]): phone_at = t
        if t >= 1 and abs(t - round(t)) < 1e-9 and t >= cfg["panicAt"] + delay:
            a = world.nodes[p["from"]]
            b = world.nodes[p["to"]] if p["to"] else None
            if staged:
                x, z, floor = sx, sz, a.floor_id
                hx, hz = cfg["toward"][0] - x, cfg["toward"][1] - z
            elif b is not None and a.floor_id == b.floor_id:
                x, z, floor = a.position.x + (b.position.x - a.position.x) * p["progress"], a.position.z + (b.position.z - a.position.z) * p["progress"], a.floor_id
                hx, hz = b.position.x - a.position.x, b.position.z - a.position.z
            else: hx = hz = 0
            size = math.hypot(hx, hz)
            if size > 0.01:
                seen = seen_changes(world, timeline.at(t - 1)[3], faces, x, z, floor, hx / size, hz / size)
                if seen:
                    witnessed.append((t, seen)); hold = cfg["lookSeconds"]
        # 변경을 본 순간부터 lookSeconds 동안 서 있는다(출발 시각 전이면 그 시간과 겹친다).
        # 서는 자리에 닿기 전에는 화면의 영남이가 이미 서 있으므로 판정상의 걷기는 멈추지 않는다.
        if hold > 0: hold -= DT
        if t >= depart and (staged or hold <= 0): step(world, p, routes, SPEED * DT)
        on_blocked = (p["from"] in blocked_nodes) if p["to"] is None else any(e in blocked_edges for e in world.edges.get((p["from"], p["to"]), []))
        if p["status"] != "OUT" and on_blocked: exposed += DT
        if abs(t * 2 - round(t * 2)) < 1e-9: trace.append((t, p["from"], p["to"], round(p["progress"], 2), p["status"], on_blocked))
        t += DT
    return dict(status=p["status"], out=t if p["status"] == "OUT" else None, exposed=exposed, witnessed=witnessed, trail=p["trail"], trace=trace, depart=depart, ahead_blocked=ahead_blocked, phone_at=phone_at)


def others(world, timeline, skip):
    people, t, last = [person(s) for s in world.starts if s != skip], 0.0, 0.0
    while t < HORIZON and any(p["status"] != "OUT" for p in people):
        for p in people:
            before = p["status"]; step(world, p, timeline.at(t)[0], SPEED * DT)
            if p["status"] == "OUT" != before: last = t
        t += DT
    return sum(p["status"] == "OUT" for p in people), len(people), last


def changes(world, timeline, cfg):
    """문 앞 복도 지점의 남은 경로가 처음 바뀌는 시점과, 그때 새로 막힌 지점의 불·연기, 불꽃만 반영했을 때의 변경 시점."""
    found = []
    for node in [cfg["watch"]]:
        origin = cfg["watch"]
        since = found[-1]["at"] + 1 if found else 1
        at = next(t for t in range(since, HORIZON) if timeline.at(t)[0][origin].path_node_ids != timeline.at(t - 1)[0][origin].path_node_ids)
        before, after = timeline.at(at - 1)[0][origin].path_node_ids, timeline.at(at)[0][origin].path_node_ids
        cells = timeline.cells(at)
        newly = sorted(timeline.at(at)[1] - timeline.at(at - 1)[1])
        fire_only = next(t for t in range(1, HORIZON) if timeline.fire_only_routes(t)[origin].path_node_ids == after or timeline.fire_only_routes(t)[origin].reason_codes)
        found.append(dict(at=at, before=before, after=after, blocked={n: (cells[f"node:{n}"].fire, cells[f"node:{n}"].smoke) for n in newly}, fire_only_at=fire_only))
    return found


def report(delays):
    world, cfg = World(), settings()
    timeline = Timeline(world, cfg["zone"], cfg["ignition"])
    result = dict(config={k: (v.model_dump() if isinstance(v, Position) else v) for k, v in cfg.items()}, changes=changes(world, timeline, cfg),
                  others=others(world, timeline, cfg["start"]), runs={})
    sx, sz, _ = stand(world, cfg)
    floor = world.nodes[cfg["watch"]].floor_id
    # 당황하기 시작할 때와 유도등이 바뀔 때, 서 있는 자리에서 보이는 불꽃·짙은 연기.
    result["sight"] = {at: in_sight(world, timeline.cells(at), sx, sz, floor) for at in [int(cfg["panicAt"]), result["changes"][0]["at"]]}
    result["route_after"] = result["changes"][0]["after"]
    for delay in delays:
        r = run(world, timeline, cfg, delay)
        result["runs"][delay] = r
    return result


def problems(result):
    """선정 조건을 어긴 것의 목록. 비어 있으면 통과다."""
    bad = []
    for change in result["changes"]:
        if not change["blocked"] or any(fire > 0 or smoke < 0.5 for fire, smoke in change["blocked"].values()): bad.append(f"{change['at']}초 변경이 연기만으로 생긴 것이 아니다: {change['blocked']}")
        if change["fire_only_at"] - change["at"] < 3: bad.append(f"{change['at']}초 변경이 불꽃보다 3초 이상 앞서지 않는다(불꽃만: {change['fire_only_at']}초)")
    ok, total, _ = result["others"]
    if ok != total: bad.append(f"다른 인원 {total}명 중 {ok}명만 탈출")
    for delay, r in result["runs"].items():
        if r["status"] != "OUT": bad.append(f"지연 {delay}초: 탈출하지 못함({r['status']})")
        if r["exposed"] > 0: bad.append(f"지연 {delay}초: 차단된 지점·통로 위에 {r['exposed']}초 있었다")
    for at, (fire, smoke) in result["sight"].items():
        if len(fire) < 3: bad.append(f"{at}초: 서 있는 자리에서 보이는 복도의 불꽃 칸이 {len(fire)}개뿐이다")
        if not smoke: bad.append(f"{at}초: 서 있는 자리에서 보이는 짙은 연기가 없다")
    cfg = result["config"]
    if result["route_after"][:2] != [cfg["watch"], cfg["ahead"]]: bad.append(f"바뀐 경로가 서 있는 자리 앞 갈림길을 지나지 않는다: {result['route_after'][:3]}")
    for delay, r in result["runs"].items():
        if r["ahead_blocked"] > 0: bad.append(f"지연 {delay}초: 문밖에 서 있는 동안 그 자리가 {r['ahead_blocked']}초 차단 대상이었다")
    base = result["runs"].get(0)
    if base is not None:
        standing = [seen for at, seen in base["witnessed"] if at < base["depart"] + 1]
        if not standing: bad.append("기본 실행에서 문밖에 서서 유도등 변경을 보지 못함")
        elif not any("FORWARD→RIGHT" in item for seen in standing for item in seen): bad.append(f"문밖에서 본 변경이 직진→우회전이 아니다: {standing}")
        if base["phone_at"] is None or base["phone_at"] < base["depart"]: bad.append("휴대폰을 꺼내는 시점이 출발 뒤가 아니다")
    return bad


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--delay", type=float, nargs="*", default=[0, 10], help="행동을 늦추는 시간(초)")
    result = report(parser.parse_args().delay)
    cfg = result["config"]
    print(f"발화 {cfg['zone']} {cfg['ignition']} · 출발 {cfg['start']} · 대피 시작 {cfg['departAt']}초")
    for c in result["changes"]:
        print(f"경로 변경 {c['at']}초(불꽃만 반영하면 {c['fire_only_at']}초): {' > '.join(c['before'][:6])} … ⇒ {' > '.join(c['after'][:6])} …")
        for node, (fire, smoke) in c["blocked"].items(): print(f"    새로 막힌 지점 {node}: 불꽃 {fire} · 연기 {smoke}")
    print(f"다른 인원: {result['others'][0]}/{result['others'][1]}명 탈출, 마지막 {result['others'][2]}초")
    for delay, r in result["runs"].items():
        print(f"지연 {delay:g}초: 출발 {r['depart']:g}초 · {r['status']} {r['out']}초 · 차단 구간 위 {r['exposed']}초 · {' > '.join(r['trail'])}")
        for at, seen in r["witnessed"]: print(f"    {at:g}초 정면 유도등 변경: {', '.join(seen)}")
        print(f"    휴대폰 {r['phone_at']}초 · 서 있는 자리 차단 {r['ahead_blocked']}초")
    for at, (fire, smoke) in result["sight"].items():
        print(f"{at}초 서 있는 자리에서 보이는 복도: 불꽃 {len(fire)}칸(가장 가까운 곳 {fire[0] if fire else '-'} m) · 짙은 연기 {len(smoke)}칸(가장 가까운 곳 {smoke[0] if smoke else '-'} m)")
    bad = problems(result)
    for line in bad: print("실패:", line)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
