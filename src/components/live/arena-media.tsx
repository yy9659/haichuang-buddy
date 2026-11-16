"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, Mic } from "lucide-react";
import { Button } from "@/components/ui/button";

type RecognitionResult = { isFinal: boolean; 0: { transcript: string } };
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { resultIndex: number; results: ArrayLike<RecognitionResult> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  abort(): void;
}
type SpeechWindow = Window & { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };

export function ArenaMedia({ active, questionId, onFinal }: { active: boolean; questionId: string | undefined; onFinal: (text: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const speech = useRef<Recognition | null>(null);
  const cameraRequest = useRef(0);
  const cameraPending = useRef(false);
  const [camera, setCamera] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [notice, setNotice] = useState("");

  function stopSpeech() {
    const recognition = speech.current;
    speech.current = null;
    if (recognition) {
      recognition.onresult = recognition.onerror = recognition.onend = null;
      recognition.abort();
    }
  }
  function stopCamera() {
    cameraRequest.current++;
    cameraPending.current = false;
    stream.current?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
    stream.current = null;
    if (video.current) video.current.srcObject = null;
  }

  useEffect(() => {
    if (!active) {
      setCamera(false);
      setListening(false);
      setInterim("");
    }
    return () => { stopCamera(); stopSpeech(); };
  }, [active]);
  useEffect(() => {
    setListening(false);
    setInterim("");
    return () => stopSpeech();
  }, [questionId]);

  async function cameraToggle() {
    if (camera || cameraPending.current) {
      stopCamera();
      setCamera(false);
      return;
    }
    if (!active) return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setNotice("摄像头需要 HTTPS 或本机安全地址。也可继续文字演练。");
      return;
    }
    setNotice("");
    const request = ++cameraRequest.current;
    cameraPending.current = true;
    try {
      const media = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      if (request !== cameraRequest.current) {
        media.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = media;
      for (const track of media.getTracks()) track.onended = () => { stopCamera(); setCamera(false); };
      if (video.current) video.current.srcObject = media;
      setCamera(true);
    } catch {
      if (request === cameraRequest.current) setNotice("无法打开摄像头，请检查浏览器权限与设备。文字演练不受影响。");
    } finally {
      if (request === cameraRequest.current) cameraPending.current = false;
    }
  }

  function speechToggle() {
    if (speech.current) {
      stopSpeech();
      setListening(false);
      setInterim("");
      return;
    }
    if (!active) return;
    const browser = window as SpeechWindow;
    const Ctor = browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
    if (!Ctor) {
      setNotice("当前浏览器不支持语音转写，请直接输入回答。");
      return;
    }
    setNotice("");
    const recognizer = new Ctor();
    speech.current = recognizer;
    recognizer.lang = "zh-CN";
    recognizer.continuous = true;
    recognizer.interimResults = true;
    recognizer.onresult = (event) => {
      if (speech.current !== recognizer) return;
      const live: string[] = [];
      const final: string[] = [];
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const row = event.results[i];
        (row.isFinal ? final : live).push(row[0]?.transcript ?? "");
      }
      if (final.length) onFinal(final.join(" "));
      setInterim(live.join(" "));
    };
    recognizer.onerror = ({ error }) => {
      stopSpeech();
      setListening(false);
      setInterim("");
      setNotice(error === "not-allowed" ? "麦克风权限未开启，可改用手动输入。" : "语音转写已中断，已识别文字仍在输入框中。");
    };
    recognizer.onend = () => {
      if (speech.current !== recognizer) return;
      speech.current = null;
      setListening(false);
      setInterim("");
    };
    try { recognizer.start(); setListening(true); }
    catch { stopSpeech(); setNotice("不能开始语音转写，请手动输入。"); }
  }

  return <div className="space-y-3">
    <div className="relative aspect-video overflow-hidden rounded-xl bg-slate-950 text-white">
      <video ref={video} autoPlay muted playsInline className="size-full object-contain" />
      {!camera && <p className="absolute inset-0 grid place-items-center text-sm text-slate-300">本机镜头预览 · 未开启</p>}
      {interim && <p className="absolute inset-x-3 bottom-3 rounded-lg bg-black/75 p-2 text-center text-sm">识别中：{interim}</p>}
    </div>
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" disabled={!active} aria-pressed={camera} onClick={() => void cameraToggle()}><Camera />{camera ? "关闭镜头" : "镜头预览"}</Button>
      <Button variant="outline" size="sm" disabled={!active} aria-pressed={listening} onClick={speechToggle}><Mic />{listening ? "停止转写" : "语音转写"}</Button>
    </div>
    <p className="text-xs text-muted-foreground">视频不上传、不保存。语音由浏览器识别，可能使用其在线服务；确认提交后才保存回答文字。</p>
    {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
  </div>;
}
