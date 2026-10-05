"use client";

import { useRouter } from "next/navigation";
import { Camera, CameraOff, Mic, MicOff, Sparkles } from "lucide-react";
import * as React from "react";

import {
  generateRehearsalQuestionAction, saveHostTranscriptAction, scoreLiveRehearsalAction,
} from "@/actions/live";
import { HostTeleprompter } from "@/components/live/host-teleprompter";
import { LiveDirectorPanel } from "@/components/live/live-director-panel";
import { LiveStatsPanel } from "@/components/live/live-stats-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  AI_REHEARSAL_AUTHOR, MAX_HOST_TRANSCRIPT_LENGTH, MAX_REHEARSAL_QUESTIONS,
  type LiveComment, type LiveHotTopic, type LiveRealMetrics, type LiveRehearsalReport,
  type LiveSession, type LiveSuggestion, type LiveTeleprompterView,
} from "@/types";

interface LiveRehearsalPanelProps {
  session: LiveSession;
  comments: LiveComment[];
  realMetrics: LiveRealMetrics;
  quickComments: readonly string[];
  teleprompter: LiveTeleprompterView;
  suggestions: LiveSuggestion[];
  hotTopics: LiveHotTopic[];
}

type SpeechResult = { isFinal: boolean; [index: number]: { transcript: string } };
type SpeechResultEvent = { resultIndex: number; results: ArrayLike<SpeechResult> };
type SpeechRecognitionInstance = {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void;
};
type SpeechWindow = Window & {
  SpeechRecognition?: new () => SpeechRecognitionInstance;
  webkitSpeechRecognition?: new () => SpeechRecognitionInstance;
};

export function LiveRehearsalPanel({
  session, comments, realMetrics, quickComments, teleprompter, suggestions, hotTopics,
}: LiveRehearsalPanelProps) {
  const router = useRouter();
  const active = session.status === "live";
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const recognitionRef = React.useRef<SpeechRecognitionInstance | null>(null);
  const questionBusyRef = React.useRef(false);
  const [cameraOn, setCameraOn] = React.useState(false);
  const [listening, setListening] = React.useState(false);
  const [interim, setInterim] = React.useState("");
  const [transcript, setTranscript] = React.useState(session.hostTranscript ?? "");
  const [report, setReport] = React.useState<LiveRehearsalReport | null>(session.rehearsalReport ?? null);
  const [aiQuestionsOn, setAiQuestionsOn] = React.useState(false);
  const [localQuestionCount, setLocalQuestionCount] = React.useState(0);
  const [questionPending, setQuestionPending] = React.useState(false);
  const [savePending, setSavePending] = React.useState(false);
  const [scorePending, setScorePending] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const persistedQuestionCount = comments.filter((item) => item.authorName === AI_REHEARSAL_AUTHOR).length;
  const questionCount = Math.max(persistedQuestionCount, localQuestionCount);

  React.useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      recognitionRef.current?.stop();
    };
  }, [session.id]);

  React.useEffect(() => {
    if (active) return;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    recognitionRef.current?.stop();
  }, [active]);

  async function toggleCamera(): Promise<void> {
    setMessage(null);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      setCameraOn(false);
      return;
    }
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setMessage("摄像头需要安全页面。请在浏览器中打开 localhost 或 HTTPS 地址使用彩排。");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      streamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      if (track) track.onended = () => {
        streamRef.current = null;
        if (videoRef.current) videoRef.current.srcObject = null;
        setCameraOn(false);
      };
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraOn(true);
    } catch (cause) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      const name = cause instanceof DOMException ? cause.name : "";
      setMessage(name === "NotAllowedError"
        ? "摄像头权限被拒绝。请允许当前页面使用摄像头；若在内嵌预览中，请改用浏览器直接打开页面。"
        : "摄像头未能启动，请检查设备连接和是否被其他程序占用。");
    }
  }

  function toggleSpeech(): void {
    setMessage(null);
    if (recognitionRef.current && listening) {
      recognitionRef.current.stop();
      setListening(false);
      return;
    }
    const browser = window as SpeechWindow;
    const Constructor = browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
    if (!Constructor) {
      setMessage("此浏览器暂不支持语音转写，可直接在下方输入口播内容。");
      return;
    }
    const recognition = new Constructor();
    recognition.lang = "zh-CN";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      const finalParts: string[] = [];
      const interimParts: string[] = [];
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = result?.[0]?.transcript.trim() ?? "";
        if (!text) continue;
        if (result.isFinal) finalParts.push(text);
        else interimParts.push(text);
      }
      if (finalParts.length) {
        setTranscript((current) => [current, ...finalParts].filter(Boolean).join("\n").slice(0, MAX_HOST_TRANSCRIPT_LENGTH));
        setReport(null);
      }
      setInterim(interimParts.join(" "));
    };
    recognition.onerror = ({ error }) => {
      if (error !== "aborted") {
        setMessage(error === "not-allowed"
          ? "麦克风权限被拒绝。请允许当前页面使用麦克风；内嵌预览受限时请在浏览器中直接打开。"
          : "语音转写中断，请检查麦克风或网络；已识别的文字仍可编辑。");
      }
      setListening(false);
    };
    recognition.onend = () => { setListening(false); setInterim(""); };
    recognitionRef.current = recognition;
    try {
      recognition.start();
      setListening(true);
    } catch {
      setMessage("语音转写未能启动，可手动输入口播内容。");
    }
  }

  const generateQuestion = React.useCallback(async () => {
    if (questionBusyRef.current || !active || questionCount >= MAX_REHEARSAL_QUESTIONS) return;
    questionBusyRef.current = true;
    setQuestionPending(true);
    setMessage(null);
    try {
      const result = await generateRehearsalQuestionAction(session.id);
      if (!result.ok) {
        setMessage(result.error.message);
        setAiQuestionsOn(false);
        return;
      }
      setLocalQuestionCount((count) => Math.max(count, persistedQuestionCount) + 1);
      if (result.data.failure) setMessage(`问题已加入，但导演建议生成失败：${result.data.failure.message}`);
      router.refresh();
    } catch {
      setMessage("AI 出题暂时无法连接，请稍后重试；也可以在左侧手动输入问题。");
      setAiQuestionsOn(false);
    } finally {
      questionBusyRef.current = false;
      setQuestionPending(false);
    }
  }, [active, questionCount, persistedQuestionCount, router, session.id]);

  React.useEffect(() => {
    if (!aiQuestionsOn || !active || questionCount >= MAX_REHEARSAL_QUESTIONS) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void generateQuestion();
    }, 90_000);
    return () => window.clearInterval(timer);
  }, [active, aiQuestionsOn, generateQuestion, questionCount]);

  async function saveTranscript(): Promise<boolean> {
    setSavePending(true);
    try {
      const result = await saveHostTranscriptAction(session.id, transcript);
      if (!result.ok) { setMessage(result.error.message); return false; }
      setMessage("口播文字已保存。");
      router.refresh();
      return true;
    } catch {
      setMessage("保存失败，请检查网络后重试；当前输入仍保留在页面上。");
      return false;
    } finally {
      setSavePending(false);
    }
  }

  async function score(): Promise<void> {
    setScorePending(true);
    setMessage(null);
    try {
      const saved = await saveHostTranscriptAction(session.id, transcript);
      if (!saved.ok) { setMessage(saved.error.message); return; }
      const result = await scoreLiveRehearsalAction(session.id);
      if (!result.ok) { setMessage(result.error.message); return; }
      setReport(result.data);
      router.refresh();
    } catch {
      setMessage("评分服务暂时无法连接。口播内容已保留，可稍后重试。");
    } finally {
      setScorePending(false);
    }
  }

  return <section className="grid items-start gap-3 xl:grid-cols-[minmax(240px,0.8fr)_minmax(420px,1.55fr)_minmax(290px,1fr)]" aria-label="直播彩排工作区">
    <div className="min-w-0"><LiveStatsPanel session={session} realMetrics={realMetrics} comments={comments} quickComments={quickComments} /></div>

    <div className="min-w-0 space-y-3">
    <div className="rounded-xl border border-border bg-card p-4 shadow-card">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div><h2 className="text-[14px] font-semibold">镜头与口播</h2>
          <p className="text-[11px] text-muted-foreground">仅在本机预览，不上传或保存视频。</p></div>
        <Button type="button" size="sm" variant="outline" onClick={() => void toggleCamera()}>
          {cameraOn ? <CameraOff /> : <Camera />}{cameraOn ? "关闭摄像头" : "打开摄像头"}
        </Button>
      </div>
      <div className="relative aspect-video overflow-hidden rounded-xl bg-slate-950">
        <video ref={videoRef} autoPlay playsInline muted className={cameraOn ? "size-full object-cover" : "hidden"} />
        {!cameraOn ? <div className="absolute inset-0 flex items-center justify-center text-[12px] text-white/65">
          点击打开摄像头预览
        </div> : null}
        <div className="absolute bottom-3 left-3 rounded-lg bg-black/45 px-2.5 py-1.5 text-[12px] text-white/90 backdrop-blur-sm">
          {session.productName} · {active ? "彩排中" : "可预览镜头"}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant={listening ? "soft" : "outline"}
          onClick={toggleSpeech}>{listening ? <MicOff /> : <Mic />}{listening ? "停止转写" : "语音转写"}</Button>
        <span className="text-[11px] text-muted-foreground">转写由浏览器提供；不支持时可手动输入。</span>
      </div>
      {interim ? <p className="mt-2 text-[11px] text-muted-foreground">识别中：{interim}</p> : null}
      <label className="mt-3 flex flex-col gap-1 text-[12px] font-medium">
        口播文字（可直接修改）
        <Textarea value={transcript} onChange={(event) => { setTranscript(event.target.value); setReport(null); }}
          maxLength={MAX_HOST_TRANSCRIPT_LENGTH} rows={5} placeholder="说话后会填入这里；也可以手动补写。评分只读取这份文字。" />
      </label>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">{transcript.length}/{MAX_HOST_TRANSCRIPT_LENGTH} 字</span>
        <Button type="button" size="sm" variant="outline" disabled={savePending} onClick={() => void saveTranscript()}>
          {savePending ? "保存中…" : "保存口播文字"}
        </Button>
      </div>
    </div>
    <HostTeleprompter session={session} teleprompter={teleprompter} showStage={false} />
    </div>

    <div className="flex min-w-0 flex-col gap-3">
      <div className="rounded-xl border border-border bg-card p-4 shadow-card">
        <div className="flex items-start justify-between gap-3">
          <div><h2 className="text-[14px] font-semibold">模拟提问</h2>
            <p className="mt-1 text-[11px] leading-5 text-muted-foreground">手动出题，或开启自动出题；每场最多 {MAX_REHEARSAL_QUESTIONS} 题。</p></div>
          <label className="inline-flex items-center gap-2 whitespace-nowrap text-[12px]">
            <input type="checkbox" checked={aiQuestionsOn && active && questionCount < MAX_REHEARSAL_QUESTIONS}
              disabled={!active || questionCount >= MAX_REHEARSAL_QUESTIONS}
              onChange={(event) => { setAiQuestionsOn(event.target.checked); if (event.target.checked) void generateQuestion(); }}
              className="size-4 accent-primary" />自动出题
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Badge variant="secondary">已生成 {questionCount}/{MAX_REHEARSAL_QUESTIONS} 题</Badge>
          <Button type="button" size="sm" variant="outline"
            disabled={!active || questionPending || questionCount >= MAX_REHEARSAL_QUESTIONS}
            onClick={() => void generateQuestion()}>
            <Sparkles />{questionPending ? "生成中…" : "AI 出一道题"}
          </Button>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">{active ? "自动模式开启后立即出题，此后每 90 秒一题。" : "重新开始彩排后即可出题。"}问题与回答建议会留在本场记录中。</p>
      </div>

      <div className="min-h-64 rounded-xl border border-border bg-card p-3 shadow-card">
        <LiveDirectorPanel suggestions={suggestions} hotTopics={hotTopics} />
      </div>

      <div className="rounded-xl border border-border bg-card p-4 shadow-card">
        <div className="flex items-center justify-between gap-2">
          <div><h2 className="text-[14px] font-semibold">本场复盘</h2>
            <p className="mt-1 text-[11px] text-muted-foreground">结束后，依据问题与口播文字评分并给出下次练习建议。</p></div>
          {report ? <Badge variant={report.isMock ? "warning" : "success"}>{report.isMock ? "演示评分" : `${report.score} 分`}</Badge> : null}
        </div>
        {!active ? <Button type="button" className="mt-3" disabled={scorePending || transcript.trim().length < 10 || comments.length === 0}
          onClick={() => void score()}><Sparkles />{scorePending ? "评分中…" : report ? "重新 AI 评分" : "一键 AI 评分"}</Button> :
          <p className="mt-3 text-[11px] text-muted-foreground">结束彩排后可评分。</p>}
        {!active && !report && (transcript.trim().length < 10 || comments.length === 0) ?
          <p className="mt-2 text-[11px] text-muted-foreground">至少需要 10 字口播文字和 1 条模拟问题。</p> : null}
        {report ? <div className="mt-3 space-y-2 text-[12px] leading-5">
          <p className="font-medium">{report.isMock ? "演示流程结果" : `${report.score} 分 · ${report.summary}`}</p>
          {report.isMock ? <p className="text-muted-foreground">{report.summary}</p> : null}
          <p>做得好：{report.strengths.join("；") || "暂无可核实亮点"}</p>
          <p>可改进：{report.improvements.join("；")}</p>
          <p>下次练习：{report.nextPractice}</p>
          <p className="text-[11px] text-muted-foreground">仅依据文字记录；未分析视频画面、音色或真实成交数据。</p>
        </div> : null}
      </div>
      {message ? <p role="status" className="text-[12px] leading-5 text-muted-foreground">{message}</p> : null}
    </div>
  </section>;
}
