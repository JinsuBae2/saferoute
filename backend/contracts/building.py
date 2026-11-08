"""Building structure and referential integrity, independent of route solving."""

from typing import Annotated, Literal

from pydantic import Field, model_validator

from .common import (
    BuildingIdentity, Display, FiniteNumber, HazardType, Identifier, PlanPoint,
    Position, PositiveInt, PositiveNumber, SOURCE_HAZARDS, SourceType, Text,
    WireModel, unique,
)


class FloorTransform(WireModel):
    floor_id: Identifier
    scale: PositiveNumber
    translation: Position


class CoordinateSystem(WireModel):
    unit: Literal["m"]
    measured: bool
    up_axis: Literal["+y"]
    plan_right_axis: Literal["+x"]
    plan_up_axis: Literal["-z"]
    origin: Position
    floor_transforms: list[FloorTransform]


class Floor(WireModel):
    floor_id: Identifier
    label: Text
    elevation: FiniteNumber


class Zone(WireModel):
    zone_id: Identifier
    floor_id: Identifier
    label: Text
    polygon: Annotated[list[PlanPoint], Field(min_length=3)]
    blocked_node_ids: list[Identifier]
    blocked_edge_ids: list[Identifier]


class Node(WireModel):
    node_id: Identifier
    floor_id: Identifier
    zone_id: Identifier
    position: Position
    kind: Literal["JUNCTION", "DOOR", "STAIR", "EXIT"]


class Edge(WireModel):
    edge_id: Identifier
    from_node_id: Identifier
    to_node_id: Identifier
    kind: Literal["CORRIDOR", "DOOR", "STAIR"]
    cost: PositiveNumber
    traversable: bool
    door_open: bool | None

    @model_validator(mode="after")
    def door_state(self):
        if (self.kind == "DOOR") != (self.door_open is not None):
            raise ValueError("door_open is boolean only for DOOR")
        return self


class Exit(WireModel):
    exit_id: Identifier
    node_id: Identifier
    enabled: bool
    assumption: Text


class Source(WireModel):
    source_id: Identifier
    source_type: SourceType
    zone_id: Identifier
    required: bool
    freshness_ms: PositiveInt
    allowed_hazard_types: Annotated[list[HazardType], Field(min_length=1)]

    @model_validator(mode="after")
    def supported_causes(self):
        unique(self.allowed_hazard_types, "hazard type")
        if not set(self.allowed_hazard_types) <= SOURCE_HAZARDS[self.source_type]:
            raise ValueError("unsupported source hazard type")
        return self


class SignFace(WireModel):
    face_id: Identifier
    view_direction: Position
    default_next_node_id: Identifier
    next_node_to_display: dict[Identifier, Display]

    @model_validator(mode="after")
    def display_mapping(self):
        if not any(self.view_direction.model_dump().values()):
            raise ValueError("view_direction must be nonzero")
        if self.default_next_node_id not in self.next_node_to_display:
            raise ValueError("default next node needs a display mapping")
        return self


class Sign(WireModel):
    sign_id: Identifier
    node_id: Identifier
    faces: Annotated[list[SignFace], Field(min_length=1)]

    @model_validator(mode="after")
    def face_ids(self):
        unique([f.face_id for f in self.faces], "face_id")
        return self


class Assumption(WireModel):
    item: Text
    basis: Text
    description: Text
    reviewer: Text | None


class Provenance(WireModel):
    source_url: Text | None
    checked_on: Annotated[str, Field(pattern=r"^\d{4}-\d{2}-\d{2}$")]
    author: Text
    description: Text


class Building(BuildingIdentity):
    coordinate_system: CoordinateSystem
    floors: Annotated[list[Floor], Field(min_length=1)]
    zones: Annotated[list[Zone], Field(min_length=1)]
    nodes: Annotated[list[Node], Field(min_length=1)]
    edges: list[Edge]
    exits: list[Exit]
    sources: list[Source]
    signs: list[Sign]
    assumptions: list[Assumption]
    provenance: Provenance

    @model_validator(mode="after")
    def references(self):
        groups = [(self.floors,"floor_id"), (self.zones,"zone_id"), (self.nodes,"node_id"),
                  (self.edges,"edge_id"), (self.exits,"exit_id"), (self.sources,"source_id"), (self.signs,"sign_id")]
        for group, key in groups:
            unique([getattr(item, key) for item in group], key)
        floors = {f.floor_id: f for f in self.floors}
        zones = {z.zone_id: z for z in self.zones}
        nodes = {n.node_id: n for n in self.nodes}
        edges = {e.edge_id: e for e in self.edges}

        def reference(value, collection, label):
            if value not in collection:
                raise ValueError(f"unknown {label}: {value}")

        transforms = self.coordinate_system.floor_transforms
        unique([t.floor_id for t in transforms], "floor transform")
        if {t.floor_id for t in transforms} != set(floors):
            raise ValueError("floor transforms must match floors")
        for zone in self.zones:
            reference(zone.floor_id, floors, "floor")
            unique(zone.blocked_node_ids, "blocked node")
            unique(zone.blocked_edge_ids, "blocked edge")
            for node_id in zone.blocked_node_ids: reference(node_id, nodes, "blocked node")
            for edge_id in zone.blocked_edge_ids: reference(edge_id, edges, "blocked edge")
        for node in self.nodes:
            reference(node.floor_id, floors, "floor")
            reference(node.zone_id, zones, "zone")
            if zones[node.zone_id].floor_id != node.floor_id:
                raise ValueError("node and zone floors differ")
        for edge in self.edges:
            reference(edge.from_node_id, nodes, "edge origin")
            reference(edge.to_node_id, nodes, "edge destination")
            if edge.from_node_id == edge.to_node_id:
                raise ValueError("self edge is not allowed")
            if nodes[edge.from_node_id].floor_id != nodes[edge.to_node_id].floor_id and edge.kind != "STAIR":
                raise ValueError("only stairs can connect floors")
        for exit in self.exits:
            reference(exit.node_id, nodes, "exit node")
            if nodes[exit.node_id].kind != "EXIT":
                raise ValueError("exit must reference an EXIT node")
        for source in self.sources: reference(source.zone_id, zones, "source zone")
        for sign in self.signs:
            reference(sign.node_id, nodes, "sign node")
            outgoing = {e.to_node_id for e in self.edges if e.from_node_id == sign.node_id and e.traversable}
            for face in sign.faces:
                for target, display in face.next_node_to_display.items():
                    if display == "EXIT":
                        if target != sign.node_id or not any(e.node_id == target and e.enabled for e in self.exits):
                            raise ValueError("EXIT mapping must reference this sign's enabled exit node")
                    elif target not in outgoing:
                        raise ValueError("sign display must reference a traversable outgoing edge")
        return self
