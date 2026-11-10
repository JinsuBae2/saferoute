"""Presentation-only names and installation hints; never routing inputs."""

from typing import Literal, Self

from .building import Building
from .common import BuildingIdentity, Identifier, Position, Text, WireModel


class SourceInstallation(WireModel):
    floor_id: Identifier
    position: Position
    basis: Literal["SIMULATED", "MEASURED"]


class SourceDisplay(WireModel):
    label: Text
    installation: SourceInstallation | None


class SignDisplay(WireModel):
    label: Text
    kind: Literal["EXIT_LOCATION", "DIRECTIONAL"]


class BuildingDisplay(BuildingIdentity):
    floor_labels: dict[Identifier, Text]
    zone_labels: dict[Identifier, Text]
    node_labels: dict[Identifier, Text]
    exit_labels: dict[Identifier, Text]
    sources: dict[Identifier, SourceDisplay]
    signs: dict[Identifier, SignDisplay]

    def validate_for(self, building: Building) -> Self:
        if (self.building_id, self.building_version) != (building.building_id, building.building_version):
            raise ValueError("display building identity or version differs")
        groups = (
            ("floor_labels", building.floors, "floor_id"),
            ("zone_labels", building.zones, "zone_id"),
            ("node_labels", building.nodes, "node_id"),
            ("exit_labels", building.exits, "exit_id"),
            ("sources", building.sources, "source_id"),
            ("signs", building.signs, "sign_id"),
        )
        for field, items, key in groups:
            if set(getattr(self, field)) != {getattr(item, key) for item in items}:
                raise ValueError(f"display {field} must match building IDs exactly")
        for source in building.sources:
            installation = self.sources[source.source_id].installation
            if installation is None:
                continue
            if installation.floor_id not in self.floor_labels:
                raise ValueError("source installation references an unknown floor")
            if installation.basis == "MEASURED" and (
                not building.coordinate_system.measured or source.source_type != "VIDEO_AI"
            ):
                raise ValueError("measured installation requires measured coordinates and a physical camera")
        exit_nodes = {exit.node_id for exit in building.exits}
        for sign in building.signs:
            if self.signs[sign.sign_id].kind != "EXIT_LOCATION":
                continue
            if sign.node_id not in exit_nodes or any(
                face.default_next_node_id != sign.node_id
                or face.next_node_to_display != {sign.node_id: "EXIT"}
                for face in sign.faces
            ):
                raise ValueError("exit location sign must use its exit node and EXIT face mappings")
        return self
