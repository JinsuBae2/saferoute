/**
 * 표지 종류에 따라 무엇을 보여줄지 정하는 순수 로직 (이슈 #70, P05).
 *
 * 유도등에는 성격이 다른 두 종류가 있다.
 * - EXIT_LOCATION: "여기가 출구다"를 알리는 고정 위치 표지. 화재가 나도 위치는 변하지 않는다.
 * - DIRECTIONAL: 갈림길에서 "저쪽으로 가라"를 알리는 가변 방향 안내. 상황에 따라 바뀐다.
 *
 * 둘을 같은 화살표로 그리면 "모든 표지가 화재 때 방향을 바꾼다"는 오해를 만든다.
 *
 * 여기서 방향을 만들지 않는다. 서버가 준 FaceResult를 어떻게 보여줄지만 정한다.
 */
import type { BuildingDisplay, FaceResult } from "@contracts";

export type SignKind = BuildingDisplay["signs"][string]["kind"];
export type DisplayValue = NonNullable<FaceResult["display"]>;
type ReasonCode = FaceResult["reason_codes"][number];

export type FacePresentation = {
  /** 이 표시면을 출구 위치로 보여줄지, 이동 방향으로 보여줄지. */
  readonly role: "EXIT_LOCATION" | "DIRECTION";
  /** 지금 보여줄 내용이 있는지. 거짓이면 안내 불가다. */
  readonly available: boolean;
  /** DIRECTION일 때의 방향. 출구 위치이거나 안내 불가면 null이다. */
  readonly display: DisplayValue | null;
  readonly reasonCodes: readonly ReasonCode[];
  /**
   * 표지 종류와 서버 명령이 맞지 않을 때의 설명.
   * 어느 쪽이 틀렸는지 화면에서 감추지 않고 드러낸다.
   */
  readonly mismatch: string | null;
};

/** 표시 자료가 아직 없거나 등록되지 않은 유도등이면 null. */
export function signKindOf(
  display: BuildingDisplay | null,
  signId: string,
): SignKind | null {
  return display?.signs[signId]?.kind ?? null;
}

/**
 * 표지 종류를 모를 때는 방향 안내로 본다.
 * 표시 자료를 못 읽었다고 해서 대피 방향을 숨기면 안 되기 때문이다.
 */
export function presentFace(kind: SignKind | null, face: FaceResult): FacePresentation {
  const reasonCodes = face.reason_codes;
  const display = face.display;

  if (kind === "EXIT_LOCATION") {
    if (display === "EXIT") {
      return { role: "EXIT_LOCATION", available: true, display: null, reasonCodes, mismatch: null };
    }
    if (display === null) {
      return { role: "EXIT_LOCATION", available: false, display: null, reasonCodes, mismatch: null };
    }
    return {
      role: "EXIT_LOCATION",
      available: false,
      display: null,
      reasonCodes,
      mismatch: "출구 위치 표지인데 이동 방향 명령을 받았습니다",
    };
  }

  if (display === "EXIT") {
    return {
      role: "DIRECTION",
      available: false,
      display: null,
      reasonCodes,
      mismatch: "가변 방향 안내인데 출구 위치 표시를 받았습니다",
    };
  }

  return {
    role: "DIRECTION",
    available: display !== null,
    display,
    reasonCodes,
    mismatch: null,
  };
}

export const SIGN_KIND_LABEL: Record<SignKind, string> = {
  EXIT_LOCATION: "출구 위치 표지",
  DIRECTIONAL: "가변 방향 안내",
};

export const SIGN_KIND_NOTE: Record<SignKind, string> = {
  EXIT_LOCATION:
    "출구가 있는 위치를 알리는 표지입니다. 출구가 안전하거나 사용 가능하다는 뜻은 아닙니다.",
  DIRECTIONAL: "상황에 따라 다음 이동 방향이 바뀌는 안내입니다.",
};
