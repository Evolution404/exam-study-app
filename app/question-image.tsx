import { useState } from "react";
import { ImageOff } from "lucide-react";

export function QuestionImage({ src, alt }: { src?: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (!src) return null;
  if (failed) return <div className="question-image-error"><ImageOff size={18} /><span>题目图片加载失败</span></div>;
  return <figure className="question-image"><img src={src} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} /></figure>;
}
