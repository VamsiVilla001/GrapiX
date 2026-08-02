import { useEffect } from "react";
import {
  createAssistantSession,
  getAssistantStatus,
  openChatStream,
  openStatusStream
} from "../lib/assistantClient";
import { useAssistantStore } from "../store/assistantStore";

/**
 * Wire the assistant broker to the store: a broadcast status stream (which model is connected)
 * and a per-session chat stream (tokens, tool events, staged calls). Mounted once, by the
 * always-present AssistantPanel, so the status chip is live even while the panel is collapsed.
 */
export function useAssistant(): void {
  const setStatus = useAssistantStore((state) => state.setStatus);
  const setSession = useAssistantStore((state) => state.setSession);
  const ingest = useAssistantStore((state) => state.ingest);

  useEffect(() => {
    let cancelled = false;
    let chatSource: EventSource | undefined;

    void getAssistantStatus()
      .then((status) => {
        if (!cancelled) setStatus(status);
      })
      .catch(() => undefined);
    const statusSource = openStatusStream(setStatus);

    void createAssistantSession()
      .then((sessionId) => {
        if (cancelled) return;
        setSession(sessionId);
        chatSource = openChatStream(sessionId, ingest);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      statusSource.close();
      chatSource?.close();
    };
  }, [setStatus, setSession, ingest]);
}
