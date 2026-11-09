"""Translate controller routes through the configured viewing faces."""

from .contracts.messages import FaceResult


def sign_faces(sign, route, controller_mode):
    faces = []
    for face in sign.faces:
        reasons = list(route.reason_codes)
        display = None
        if controller_mode == "INITIALIZING":
            mode = "UNKNOWN"
        elif reasons:
            mode = "NO_ROUTE"
        else:
            display = face.next_node_to_display.get(route.next_node_id or sign.node_id)
            mode = "DEFAULT" if controller_mode == "NORMAL" else "DYNAMIC"
            if display is None:
                mode, reasons = "NO_ROUTE", ["UNSUPPORTED_DISPLAY"]
        available = mode in {"DEFAULT", "DYNAMIC"}
        faces.append(FaceResult(face_id=face.face_id, mode=mode, display=display,
            next_node_id=route.next_node_id if available else None,
            exit_id=route.exit_id if available else None, reason_codes=reasons))
    return faces
