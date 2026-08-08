import { useState } from "react";
import { Plus, Save, Trash2, X } from "lucide-react";
import type { Question, QuestionType } from "@/lib/types";

export type QuestionChanges = Pick<Question, "stem" | "options" | "answer" | "type" | "tags">;

export function QuestionEditor({ question, onSave, onCancel }: {
  question: Question;
  onSave: (changes: QuestionChanges) => Promise<void>;
  onCancel: () => void;
}) {
  const [stem, setStem] = useState(question.stem);
  const [options, setOptions] = useState([...question.options]);
  const [answer, setAnswer] = useState(question.answer);
  const [type, setType] = useState<QuestionType>(question.type);
  const [tags, setTags] = useState(question.tags.join("，"));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function changeType(value: QuestionType) {
    setType(value);
    if (value === "判断") {
      setOptions(["正确", "错误"]);
      setAnswer("A");
    } else if (type === "判断") {
      setOptions(["", "", "", ""]);
      setAnswer("A");
    }
  }

  function toggleAnswer(letter: string) {
    if (type === "多选") {
      const next = answer.includes(letter) ? answer.replace(letter, "") : `${answer}${letter}`;
      setAnswer([...next].sort().join(""));
    } else setAnswer(letter);
  }

  async function save() {
    try {
      setSaving(true);
      setError("");
      await onSave({
        stem,
        options,
        answer,
        type,
        tags: tags.split(/[，,、\n]+/).map((tag) => tag.trim()).filter(Boolean),
      });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存失败");
      setSaving(false);
    }
  }

  return <div className="editor-backdrop" role="presentation"><section className="question-editor" role="dialog" aria-modal="true" aria-labelledby="question-editor-title">
    <header><div><p className="eyebrow">仅修改你的个人副本</p><h2 id="question-editor-title">编辑题目</h2></div><button className="icon-button" aria-label="关闭编辑器" onClick={onCancel}><X size={18} /></button></header>
    <div className="editor-body">
      <label>题型<select value={type} onChange={(event) => changeType(event.target.value as QuestionType)}><option value="判断">判断</option><option value="单选">单选</option><option value="多选">多选</option></select></label>
      <label>题干<textarea value={stem} onChange={(event) => setStem(event.target.value)} rows={4} /></label>
      <div className="editor-label"><span>选项与正确答案</span><small>点击字母标记正确答案</small></div>
      <div className="editor-options">{options.map((option, index) => { const letter = String.fromCharCode(65 + index); return <div key={`${letter}-${index}`}><button aria-label={`将 ${letter} 设为正确答案`} className={answer.includes(letter) ? "answer-selected" : ""} onClick={() => toggleAnswer(letter)}>{letter}</button><input value={option} onChange={(event) => setOptions(options.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} placeholder={`选项 ${letter}`} />{type !== "判断" && options.length > 2 && <button aria-label={`删除选项 ${letter}`} className="delete-option" onClick={() => { const next = options.filter((_, itemIndex) => itemIndex !== index); setOptions(next); setAnswer(""); }}><Trash2 size={16} /></button>}</div>; })}</div>
      {type !== "判断" && options.length < 8 && <button className="add-option" onClick={() => setOptions([...options, ""])}><Plus size={16} />添加选项</button>}
      <label>自定义标签<input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="例如：弧垂，易混，必背" /><small>使用逗号分隔，可添加、修改或删除标签。</small></label>
      {error && <p className="editor-error">{error}</p>}
    </div>
    <footer><button className="secondary-action" onClick={onCancel}>取消</button><button className="primary" disabled={saving} onClick={() => void save()}><Save size={17} />{saving ? "保存中…" : "保存修改"}</button></footer>
  </section></div>;
}
