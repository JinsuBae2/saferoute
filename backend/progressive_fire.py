"""Demo-only propagation through room cells and registered open connections.

Rates are presentation assumptions, not fire/air-flow predictions. Route weights
are never reused as metres. Closed doors and walls do not create connections.
"""

from dataclasses import dataclass
from functools import lru_cache
import heapq
import json
import math
from pathlib import Path

from .contracts.common import PlanPoint, Position
from .contracts.messages import FireSimulation, HazardCell, SimulatedFire

CELL = 2.0
FIRE_MS_PER_M, SMOKE_MS_PER_M = 4000, 1200
FIRE_FLOOR_DELAY, SMOKE_FLOOR_DELAY = 20000, 8000


def contains(polygon, x, z):
    inside = False
    for a, b in zip(polygon, [*polygon[1:], polygon[0]]):
        cross = (x-a.x)*(b.z-a.z) - (z-a.z)*(b.x-a.x)
        if abs(cross) < 1e-7 and min(a.x,b.x)-1e-7 <= x <= max(a.x,b.x)+1e-7 and min(a.z,b.z)-1e-7 <= z <= max(a.z,b.z)+1e-7:
            return True
        if (a.z > z) != (b.z > z) and x < (b.x-a.x)*(z-a.z)/(b.z-a.z)+a.x:
            inside = not inside
    return inside


def distance(a, b):
    return math.dist((a.x,a.y,a.z),(b.x,b.y,b.z))


@lru_cache(maxsize=4)
def walls_for(building_id, version):
    # Only the version-matched demo geometry is used; real alarm policy is unchanged.
    if building_id != "WFI": return {}
    path = Path(__file__).resolve().parents[1] / "data/space/wfi-geometry-v1.json"
    geometry = json.loads(path.read_text(encoding="utf-8"))
    if (building_id,version) != (geometry["building_id"],geometry["building_version"]): return {}
    return {f["floor_id"]:[tuple(w) for w in f["walls"] if not any(
        s["kind"] == "OPEN" and f["floor_id"] in s["floors"]
        and contains([PlanPoint(**p) for p in s["footprint"]],(w[0]+w[2])/2,(w[1]+w[3])/2)
        for s in geometry["stairs"])] for f in geometry["floors"]}


def in_wall(walls, position):
    return any(x0 < position.x < x1 and z0 < position.z < z1 for x0,z0,x1,z1 in walls)


def crosses_wall(a, b, wall):
    low,high = 0.,1.
    for start,end,lo,hi in [(a.x,b.x,wall[0],wall[2]),(a.z,b.z,wall[1],wall[3])]:
        delta = end-start
        if abs(delta) < 1e-9:
            if not lo < start < hi: return False
        else:
            entry,exit = sorted(((lo-start)/delta,(hi-start)/delta))
            low,high = max(low,entry),min(high,exit)
    return low < high


def segment_distance(p, a, b):
    start, end, point = (a.x,a.y,a.z),(b.x,b.y,b.z),(p.x,p.y,p.z)
    delta = tuple(y-x for x,y in zip(start,end))
    size = sum(d*d for d in delta)
    t = min(1.,max(0.,sum((x-y)*d for x,y,d in zip(point,start,delta))/size)) if size else 0
    return math.dist(point,tuple(x+t*d for x,d in zip(start,delta)))


@dataclass
class Propagation:
    state: FireSimulation | None
    nodes: dict
    edges: dict

    def key(self):
        return tuple((kind, item, tuple(sorted(sources))) for kind, items in [("n",self.nodes),("e",self.edges)]
                     for item,sources in sorted(items.items()))


class ProgressiveFire:
    def __init__(self, building):
        self.building = building
        self.zones = {z.zone_id:z for z in building.zones}
        self.walls = walls_for(building.building_id,building.building_version)
        self.points, self.graph, self.by_zone, self.edge_points = {}, {}, {}, {}
        self.incidents = {}
        self._cache_key, self._cache = None, None
        elevations = {f.floor_id:f.elevation for f in building.floors}
        for zone in building.zones:
            grid = {}
            lo_x, hi_x = min(p.x for p in zone.polygon), max(p.x for p in zone.polygon)
            lo_z, hi_z = min(p.z for p in zone.polygon), max(p.z for p in zone.polygon)
            for i in range(math.ceil((hi_x-lo_x)/CELL)):
                for j in range(math.ceil((hi_z-lo_z)/CELL)):
                    x, z = min(lo_x+(i+.5)*CELL,(lo_x+hi_x)/2 if hi_x-lo_x<CELL else hi_x-.1), min(lo_z+(j+.5)*CELL,(lo_z+hi_z)/2 if hi_z-lo_z<CELL else hi_z-.1)
                    if not contains(zone.polygon,x,z) or in_wall(self.walls.get(zone.floor_id,[]),Position(x=x,y=elevations[zone.floor_id],z=z)): continue
                    key = f"cell:{zone.zone_id}:{i}:{j}"
                    self._point(key,zone.zone_id,Position(x=x,y=elevations[zone.floor_id],z=z))
                    grid[i,j] = key
            for (i,j), key in grid.items():
                for neighbor in [(i+1,j),(i,j+1)]:
                    if neighbor in grid and self._within(zone, self.points[key][1],self.points[grid[neighbor]][1]):
                        self._link(key,grid[neighbor])
        for node in building.nodes:
            key = f"node:{node.node_id}"
            self._point(key,node.zone_id,node.position)
            self._attach(key,node.zone_id)
        pairs = {}
        nodes = {n.node_id:n for n in building.nodes}
        for edge in building.edges:
            if not edge.traversable: continue
            pair = (*sorted([edge.from_node_id,edge.to_node_id]),edge.door_open)
            if pair in pairs:
                self.edge_points[edge.edge_id] = pairs[pair]
                continue
            a, b = nodes[edge.from_node_id], nodes[edge.to_node_id]
            keys = [f"node:{a.node_id}"]
            steps = max(1,math.ceil(distance(a.position,b.position)/CELL)) if a.floor_id == b.floor_id else 1
            for i in range(1,steps):
                t = i/steps
                p = Position(**{axis:getattr(a.position,axis)*(1-t)+getattr(b.position,axis)*t for axis in ["x","y","z"]})
                zone_id = a.zone_id if contains(self.zones[a.zone_id].polygon,p.x,p.z) else b.zone_id
                key = f"edge:{edge.edge_id}:{i}"
                self._point(key,zone_id,p)
                self._attach(key,zone_id)
                keys.append(key)
            keys.append(f"node:{b.node_id}")
            # A closed door may still be opened for evacuation. Sample its path
            # for danger, but never make it a propagation connection.
            if edge.door_open is not False:
                for left,right in zip(keys,keys[1:]): self._link(left,right)
            pairs[pair] = keys
            self.edge_points[edge.edge_id] = keys

    def _point(self, key, zone_id, position):
        self.points[key] = (zone_id,position)
        self.graph[key] = []
        self.by_zone.setdefault(zone_id,[]).append(key)

    def _link(self, a, b):
        length = distance(self.points[a][1],self.points[b][1])
        floor = self.zones[self.points[a][0]].floor_id != self.zones[self.points[b][0]].floor_id
        self.graph[a].append((b,length,floor))
        self.graph[b].append((a,length,floor))

    def _within(self, zone, a, b):
        if any(crosses_wall(a,b,wall) for wall in self.walls.get(zone.floor_id,[])): return False
        steps = max(1,math.ceil(distance(a,b)/.25))
        return all(contains(zone.polygon,a.x+(b.x-a.x)*i/steps,a.z+(b.z-a.z)*i/steps) for i in range(steps+1))

    def _neighbors(self, zone_id, position, exclude=None):
        zone = self.zones[zone_id]
        candidates = sorted((distance(position,self.points[key][1]),key) for key in self.by_zone.get(zone_id,[]) if key != exclude)
        neighbors = []
        for length,key in candidates:
            if self._within(zone,position,self.points[key][1]): neighbors.append((length,key))
            if len(neighbors) == 4: break
        return neighbors

    def _attach(self, key, zone_id):
        for _,neighbor in self._neighbors(zone_id,self.points[key][1],key): self._link(key,neighbor)

    def ignite(self, source_id, zone_id, position, now_ms):
        if source_id in self.incidents: return
        neighbors = self._neighbors(zone_id,position)
        times = []
        for rate,delay in [(FIRE_MS_PER_M,FIRE_FLOOR_DELAY),(SMOKE_MS_PER_M,SMOKE_FLOOR_DELAY)]:
            arrival = {key:length*rate for length,key in neighbors}
            queue = [(value,key) for key,value in arrival.items()]
            heapq.heapify(queue)
            while queue:
                value,key = heapq.heappop(queue)
                if value != arrival[key]: continue
                for other,length,floor in self.graph[key]:
                    next_value = value+length*rate+(delay if floor else 0)
                    if next_value < arrival.get(other,math.inf):
                        arrival[other] = next_value
                        heapq.heappush(queue,(next_value,other))
            times.append(arrival)
        nodes = {n.node_id:n for n in self.building.nodes}
        initial_nodes = {n.node_id for n in nodes.values() if n.zone_id == zone_id and distance(n.position,position) <= .35}
        initial_edges = {e.edge_id for e in self.building.edges if e.traversable
                         and zone_id in {nodes[e.from_node_id].zone_id,nodes[e.to_node_id].zone_id}
                         and segment_distance(position,nodes[e.from_node_id].position,nodes[e.to_node_id].position) <= .35}
        self.incidents[source_id] = (zone_id,position,now_ms,*times,initial_nodes,initial_edges)
        self._cache_key = None

    def remove(self, source_id):
        self.incidents.pop(source_id,None)
        self._cache_key = None

    def reset(self):
        self.incidents.clear()
        self._cache_key = None

    def evaluate(self, now_ms):
        key = tuple((source,int(max(0,now_ms-data[2])//1000)) for source,data in self.incidents.items())
        if key == self._cache_key: return self._cache
        self._cache_key = key
        if not self.incidents:
            self._cache = Propagation(None,{}, {})
            return self._cache
        values, hazards, fires, origins, direct_edges = {}, {}, [], [], {}
        for source,(zone_id,position,started,fire_times,smoke_times,initial_nodes,initial_edges) in self.incidents.items():
            elapsed = int(max(0,now_ms-started)//1000)*1000
            fires.append(SimulatedFire(source_id=source,zone_id=zone_id,position=position,elapsed_ms=elapsed))
            for node in initial_nodes: hazards.setdefault(f"node:{node}",set()).add(source)
            for edge in initial_edges: direct_edges.setdefault(edge,set()).add(source)
            origins.append(HazardCell(cell_id=f"origin:{source}",zone_id=zone_id,floor_id=self.zones[zone_id].floor_id,
                                      position=position,fire=min(1.,.18+elapsed/20000),smoke=min(1.,elapsed/12000)))
            for point in fire_times.keys() | smoke_times.keys():
                ft, st = fire_times.get(point,math.inf), smoke_times.get(point,math.inf)
                fire = min(1.,.18+(elapsed-ft)/20000) if elapsed >= ft else 0.
                smoke = min(1.,max(0.,(elapsed-st)/12000))
                old = values.get(point,(0.,0.))
                values[point] = max(old[0],fire),max(old[1],smoke)
                if fire > 0 or smoke >= .5: hazards.setdefault(point,set()).add(source)
        cells = [HazardCell(cell_id=point,zone_id=self.points[point][0],floor_id=self.zones[self.points[point][0]].floor_id,
                            position=self.points[point][1],fire=round(fire,3),smoke=round(smoke,3))
                 for point,(fire,smoke) in sorted(values.items()) if fire >= .001 or smoke >= .001]
        nodes = {n.node_id:hazards[f"node:{n.node_id}"] for n in self.building.nodes if f"node:{n.node_id}" in hazards}
        edges = {edge:set().union(*(hazards.get(p,set()) for p in points)) for edge,points in self.edge_points.items()}
        for edge,sources in direct_edges.items(): edges.setdefault(edge,set()).update(sources)
        self._cache = Propagation(FireSimulation(fires=fires,cells=[*origins,*cells]),nodes,{k:v for k,v in edges.items() if v})
        return self._cache
