/**
 * 지금 화면이 공동 시연인지 개인 체험방인지. 주소(#/room…)로만 정하고, 그에 따라 부르는 API가 갈린다.
 * 어느 방인지는 여기서 정하지 않는다. 서버가 발급한 HttpOnly 쿠키로 서버가 정한다.
 */
export function inRoom(): boolean {
  return typeof location !== "undefined" && location.hash.startsWith("#/room");
}

export const apiBase = () => (inRoom() ? "/api/room" : "/api");
export const simBase = () => (inRoom() ? "/api/room/sim" : "/sim");
export const signPath = (signId: string) => `${inRoom() ? "/room" : ""}/sign/${encodeURIComponent(signId)}`;

const ROOM_KEY = "saferoute-room";

/** 이 브라우저가 마지막으로 들어간 방 번호. 방이 사라졌을 때 "종료되었다"고 알리는 데와, 저장 자료를 방별로 나누는 데만 쓴다. */
export function rememberedRoom(): string | null {
  try { return localStorage.getItem(ROOM_KEY); } catch { return null; }
}

export function rememberRoom(roomId: string | null): void {
  try {
    if (roomId === null) localStorage.removeItem(ROOM_KEY);
    else localStorage.setItem(ROOM_KEY, roomId);
  } catch { /* 저장소를 못 쓰는 브라우저에서는 새로고침 복원만 빠진다 */ }
}

/** 브라우저 저장 자료를 나누는 이름. 공동 시연과 각 방의 자료가 섞이지 않는다. */
export const storageScope = () => (inRoom() ? `room-${rememberedRoom() ?? "unknown"}` : "shared");
