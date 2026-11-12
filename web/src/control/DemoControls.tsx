/**
 * 머리말의 시연 조작 (이슈 #21).
 *
 * 전에는 3D 아래 「시연 · 화재 위치와 내 위치를 정하고 시작합니다」 카드가 화재 위치 고르기,
 * 내 위치 고르기, 시작·초기화·해제를 한 줄씩 들고 있었다. 고를 때마다 화면을 내려야 해서
 * 고르는 일은 3D 도면 클릭에 맡기고 여기에는 누를 것만 남긴다.
 *
 * 도면을 눌러 화재 위치를 정하고, 한 번 더 눌러 내 위치를 정하면 「시연 시작」이 열린다.
 * 「처음부터」는 전과 같은 초기화다. 불을 끄는 것도 이것으로 한다. 원인 하나만 끄려면
 * 접어 둔 「활성 경보」에서 한다.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Building, BuildingDisplay, Position, StateSnapshot } from "@contracts";
import { ApiError, restartSimulation } from "../api/client";
import { inRoom } from "../api/scope";
import { enableSound } from "./alarmSound";
import { demoMessage, ManualFireControl, manualFireSources } from "./manualFire";
import type { ManualAction, ManualResult } from "./manualFire";

type Props = {
  readonly building: Building;
  readonly display: BuildingDisplay | null;
  readonly state: StateSnapshot;
  readonly connected: boolean;
  /** 도면에서 고른 화재 위치. 비어 있으면 시작할 수 없다. */
  readonly zoneId: string;
  readonly ignitionPosition?: Position | null;
  /** 내 위치를 골랐는지. 3D가 알려 준다. 경로가 보여야 시작한다. */
  readonly hasStart: boolean;
  /** 방금 눌렀지만 화재 위치로 쓸 수 없는 구역. */
  readonly refusedZoneId?: string | null;
};

export function DemoControls({ building, display, state, connected, zoneId, ignitionPosition, hasStart, refusedZoneId = null }: Props) {
  const control = useMemo(() => new ManualFireControl(building, state.run_id), [building, state.run_id]);
  const mounted = useRef(false);
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ text: string; result: ManualResult | null; failed: boolean } | null>(null);
  const sources = useMemo(() => manualFireSources(building), [building]);
  const source = sources.find((item) => item.zone_id === zoneId);
  const active = new Set(state.active_causes.filter((cause) => cause.hazard_type === "FIRE").map((cause) => cause.source_id));
  const name = (id: string) => display?.zone_labels[id] ?? building.zones.find((zone) => zone.zone_id === id)?.label ?? id;
  const disabled = pending || !connected;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; control.cancel(); };
  }, [control]);

  async function act(action: ManualAction) {
    if (disabled || busy.current) return;
    // 시연 시작은 사용자가 직접 누른 동작이라 여기서 소리를 켤 수 있다. 이후 경보 변화에는 방송이 스스로 반응한다.
    if (action.kind === "ignite") enableSound();
    busy.current = true;
    setPending(true); setNotice(null);
    const target = action.kind === "clear_all" ? "모든 시험 화재" : name(action.zoneId);
    try {
      const result = await control.run(action);
      if (mounted.current) setNotice({ text: `${target} · 발생 ${result.completed}건 서버 수락`, result, failed: false });
    } catch (error) {
      if (mounted.current) setNotice({ text: `${target} · ${error instanceof Error ? error.message : "결과를 확인하지 못했습니다"}`, result: null, failed: true });
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }

  /** 실행기에 재실행을 요청한다. 성공하면 run_id가 바뀌어 화면이 처음 상태로 돌아간다. */
  async function restart() {
    if (pending || busy.current) return;
    if (!window.confirm(inRoom() ? "처음부터 다시 시작할까요? 진행 중인 화재와 대피가 모두 지워집니다."
      : "공동 시연을 처음부터 다시 시작할까요? 지금 보고 있는 모든 사람의 화면이 초기화됩니다.")) return;
    busy.current = true;
    setPending(true); setNotice(null);
    try {
      try {
        await restartSimulation(AbortSignal.timeout(8000));
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        throw new Error([404, 405].includes(error.status) ? "지금 실행기는 재실행을 지원하지 않습니다" : `${error.message} (${error.code ?? error.status})`, { cause: error });
      }
      if (mounted.current) setNotice({ text: "처음부터 · 새 실행으로 다시 시작합니다", result: null, failed: false });
    } catch (error) {
      if (mounted.current) setNotice({ text: `처음부터 실패 · ${error instanceof Error ? error.message : "응답을 확인하지 못했습니다"}`, result: null, failed: true });
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }

  const refused = refusedZoneId === null ? null
    : `${name(refusedZoneId)}은(는) 통로와 이어진 근거가 없어 화재 위치로 쓸 수 없습니다. 다른 곳을 누르세요`;
  const blocked = refused
    ?? (source === undefined
    ? "1/3 · 3D 도면에서 화재 위치를 누르세요"
    : !hasStart
      ? "2/3 · 도면을 한 번 더 눌러 내 위치를 정하세요"
      : active.has(source.source_id)
        ? "고른 자리에 이미 시험 화재가 있습니다"
        : null);

  return (
    <div className="control__demo">
      <div className="control__demo-buttons">
        <button
          type="button"
          className="control__demo-start"
          disabled={disabled || blocked !== null}
          title={blocked ?? "고른 자리에 시험 화재를 냅니다"}
          onClick={() => void act({ kind: "ignite", zoneId, position: ignitionPosition })}
        >
          시연 시작
        </button>
        <button
          type="button"
          className="control__demo-reset"
          disabled={pending}
          title="제어기와 시뮬레이션을 처음 상태로 돌립니다. 시험 화재도 모두 꺼집니다"
          onClick={() => void restart()}
        >
          처음부터
        </button>
      </div>
      <p className="control__demo-note">경보·대피는 즉시 시작하고 불·연기는 점차 퍼집니다. 시연용 확산입니다. 시작하면 경보음이 켜집니다.</p>
      <p className="control__demo-note" role="status" aria-live="polite">
        {demoMessage(pending, refused, notice?.text ?? null, blocked ?? "3/3 · 「시연 시작」을 누르면 고른 자리에 화재가 납니다")}
        {!pending && refused === null && notice?.result && (state.guidance_version >= notice.result.guidanceVersion ? " · 반영 확인" : " · 반영 대기")}
      </p>
    </div>
  );
}
