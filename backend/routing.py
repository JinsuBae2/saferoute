"""Directed, positive-cost route forests. No simulator truth or future input."""

from fractions import Fraction
from collections.abc import Sequence
import heapq
from math import isfinite

from .contracts.building import Building
from .contracts.messages import BlockedEdge, BlockedNode, Route


def unavailable_routes(building: Building, reason: str) -> list[Route]:
    return [Route(node_id=node.node_id,next_node_id=None,exit_id=None,path_node_ids=[],
                  cost=None,reason_codes=[reason]) for node in sorted(building.nodes,key=lambda n:n.node_id)]


def _costs(building):
    # Decimal wire costs (e.g. 0.1 + 0.2 versus 0.3) must have deterministic ties.
    costs = {edge.edge_id: Fraction(str(edge.cost)) for edge in building.edges}
    if any(cost <= 0 for cost in costs.values()):
        raise ValueError("route edge costs must be positive")
    try:
        representable = isfinite(float(sum(costs.values(), Fraction(0))))
    except OverflowError:
        representable = False
    if not representable:
        raise ValueError("total edge cost exceeds the finite wire-number range")
    return costs


def _tree(building, costs, blocked_nodes, blocked_edges, exit_ids, default_next):
    incoming = {node.node_id: [] for node in building.nodes}
    for edge in building.edges:
        if not edge.traversable or edge.edge_id in blocked_edges:
            continue
        if edge.from_node_id in blocked_nodes or edge.to_node_id in blocked_nodes:
            continue
        if default_next is not None and edge.from_node_id in default_next and edge.to_node_id != default_next[edge.from_node_id]:
            continue
        incoming[edge.to_node_id].append(edge)

    best, queue = {}, []
    for exit in building.exits:
        if exit.exit_id not in exit_ids or exit.node_id in blocked_nodes:
            continue
        rank = (Fraction(0), exit.exit_id, "", "")
        if exit.node_id not in best or rank < best[exit.node_id]:
            best[exit.node_id] = rank
            heapq.heappush(queue, (*rank,exit.node_id))
    while queue:
        distance, exit_id, next_node, edge_id, node = heapq.heappop(queue)
        if best[node] != (distance,exit_id,next_node,edge_id):
            continue
        for edge in incoming[node]:
            candidate = (distance + costs[edge.edge_id],exit_id,node,edge.edge_id)
            if edge.from_node_id not in best or candidate < best[edge.from_node_id]:
                best[edge.from_node_id] = candidate
                heapq.heappush(queue, (*candidate,edge.from_node_id))
    return best


def _blocked(items, key, known_ids):
    reasons = {}
    for item in items:
        item_id = getattr(item,key)
        if item_id not in known_ids:
            raise ValueError(f"unknown blocked {key}: {item_id}")
        reasons.setdefault(item_id,set()).update(item.reason_codes)
    unknown_only = {item_id for item_id,values in reasons.items() if values == {"REQUIRED_OBSERVATION_UNKNOWN"}}
    return reasons, unknown_only


def calculate_routes(
    building: Building,
    blocked_nodes: Sequence[BlockedNode] = (),
    blocked_edges: Sequence[BlockedEdge] = (),
    *,
    default_next: dict[str,str] | None = None,
) -> list[Route]:
    """Reverse multi-exit Dijkstra, tied by exit_id, next_node_id, then edge_id.

    Extra reasons describe a condition whose relaxation restores a route, or
    the loss of every exit on an originally connected graph. Diagnostic trees
    never provide a route through an excluded area.
    """
    costs = _costs(building)
    node_ids = {node.node_id for node in building.nodes}
    node_reasons, unknown_nodes = _blocked(blocked_nodes,"node_id",node_ids)
    edge_reasons, unknown_edges = _blocked(blocked_edges,"edge_id",{e.edge_id for e in building.edges})
    excluded_nodes, excluded_edges = set(node_reasons), set(edge_reasons)
    enabled = {exit.exit_id for exit in building.exits if exit.enabled}
    tree = _tree(building,costs,excluded_nodes,excluded_edges,enabled,default_next)

    restored_observations = {}
    if unknown_nodes or unknown_edges:
        restored_observations = _tree(building,costs,excluded_nodes-unknown_nodes,excluded_edges-unknown_edges,enabled,default_next)
    restored_exits = {}
    if any(not exit.enabled for exit in building.exits):
        restored_exits = _tree(building,costs,excluded_nodes,excluded_edges,{e.exit_id for e in building.exits},default_next)
    if building.exits and not any(e.enabled and e.node_id not in excluded_nodes for e in building.exits):
        restored_exits = _tree(building,costs,set(),set(),{e.exit_id for e in building.exits},default_next)

    routes = []
    for node in sorted(node_ids):
        reasons = []
        if node in excluded_nodes:
            reasons.append("ORIGIN_BLOCKED")
            if "REQUIRED_OBSERVATION_UNKNOWN" in node_reasons[node]:
                reasons.append("REQUIRED_OBSERVATION_UNKNOWN")
        elif node not in tree:
            reasons.append("NO_REACHABLE_EXIT")
            if node in restored_exits: reasons.append("EXIT_UNAVAILABLE")
            if node in restored_observations: reasons.append("REQUIRED_OBSERVATION_UNKNOWN")
        if reasons:
            routes.append(Route(node_id=node,next_node_id=None,exit_id=None,path_node_ids=[],cost=None,reason_codes=reasons))
            continue

        distance, exit_id, next_node, _ = tree[node]
        path, visited, current = [], set(), node
        while True:
            if current in visited:
                raise ValueError("route forest contains a cycle")
            visited.add(current)
            path.append(current)
            current_distance, current_exit, following, _ = tree[current]
            if current_exit != exit_id:
                raise ValueError("route forest switches destination midway")
            if not following: break
            if tree[following][0] >= current_distance:
                raise ValueError("route distance must strictly decrease at each hop")
            current = following
        routes.append(Route(node_id=node,next_node_id=next_node or None,exit_id=exit_id,
                            path_node_ids=path,cost=float(distance),reason_codes=[]))
    return routes


def validate_default_routes(building: Building) -> list[Route]:
    """Pin signed nodes to their agreed defaults; complete unsigned nodes by cost."""
    defaults = {}
    for sign in building.signs:
        for face in sign.faces:
            target = face.default_next_node_id
            if sign.node_id in defaults and defaults[sign.node_id] != target:
                raise ValueError(f"conflicting default directions at {sign.node_id}")
            defaults[sign.node_id] = target
    routes = calculate_routes(building,default_next=defaults)
    by_node = {route.node_id:route for route in routes}
    for node in defaults:
        if not by_node[node].path_node_ids:
            raise ValueError(f"default guidance at {node} does not reach an enabled exit")
    return routes
