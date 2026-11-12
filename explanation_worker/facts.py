"""Explicit allowlist for a validated current controller snapshot."""

from backend.contracts.messages import StateSnapshot


def extract_basis(state: StateSnapshot) -> dict:
    """Copy current facts only; never send the snapshot's commands or ACKs.

    This does not establish freshness. The caller must read the current session
    and recheck identity/TTL when accepting a model response.
    """
    facts = {"mode": {"controller_mode": state.controller_mode}}
    for cause in sorted(state.active_causes, key=lambda item: (item.source_id, item.hazard_type)):
        facts[f"cause:{cause.source_id}:{cause.hazard_type}"] = {
            "source_id": cause.source_id, "hazard_type": cause.hazard_type,
        }
    for node in sorted(state.blocked_nodes, key=lambda item: item.node_id):
        facts[f"blocked-node:{node.node_id}"] = {
            "node_id": node.node_id, "source_ids": sorted(node.source_ids),
            "reason_codes": sorted(node.reason_codes),
        }
    for edge in sorted(state.blocked_edges, key=lambda item: item.edge_id):
        facts[f"blocked-edge:{edge.edge_id}"] = {
            "edge_id": edge.edge_id, "source_ids": sorted(edge.source_ids),
            "reason_codes": sorted(edge.reason_codes),
        }
    for route in sorted(state.routes, key=lambda item: item.node_id):
        facts[f"route:{route.node_id}"] = {
            "node_id": route.node_id, "next_node_id": route.next_node_id,
            "exit_id": route.exit_id, "path_node_ids": list(route.path_node_ids),
            "cost": route.cost, "reason_codes": sorted(route.reason_codes),
        }
    return {
        "schema_version": state.schema_version,
        "run_id": state.run_id,
        "building_id": state.building_id,
        "building_version": state.building_version,
        "guidance_version": state.guidance_version,
        "basis_generated_at": state.generated_at,
        "facts": facts,
    }

def presentation_basis(state: StateSnapshot) -> dict:
    """Keep a few actual examples per category in a building-wide two-sentence explanation."""
    basis = extract_basis(state)
    if len(basis["facts"]) <= 16:
        return basis
    counts, selected = {}, {}
    for key, fact in basis["facts"].items():
        category = key.partition(":")[0]
        count = counts.get(category, 0)
        if count < 3:
            selected[key] = fact
            counts[category] = count + 1
    return {**basis, "facts": selected}
