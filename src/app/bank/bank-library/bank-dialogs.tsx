"use client";
import { useState } from "react";
import { X } from "lucide-react";
import { AppSelect } from "@/app/ui/app-select";
import { ModalPortal } from "@/app/ui/modal-portal";
import { createBankV7 } from "@/lib/db/db-v7";
import { bankTitle, saveBank, saveBankFolder, type Bank, type BankFolder } from "./bank-library-shared";

export function BankCreateDialog({ folders, onClose, onCreated }: { folders: BankFolder[]; onClose: () => void; onCreated: (bank: Bank) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [folderId, setFolderId] = useState("unfiled");
  const [color, setColor] = useState("#dfe9e2");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function createBank() {
    if (!name.trim() || busy) return;
    try {
      setBusy(true);
      setError("");
      const bank = await createBankV7({
        name: name.trim(),
        description,
        folderId: folderId === "unfiled" ? undefined : folderId,
        color,
      });
      onCreated(bank);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "题库创建失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  return <ModalPortal><div className="simple-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}><section className="simple-dialog bank-create-dialog" role="dialog" aria-modal="true" aria-labelledby="bank-create-title"><header><div><span className="section-kicker">手动维护题目</span><h2 id="bank-create-title">新建空白题库</h2></div><button className="icon-button" disabled={busy} aria-label="关闭新建题库" onClick={onClose}><X size={17} /></button></header><div><p className="bank-create-intro">先建立题库资料，创建后会直接进入试题管理，可以逐题添加和编辑。</p><label>题库名称<input value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void createBank(); }} placeholder="例如：变电运行基础" /></label><label>题库说明<textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="用途、知识范围或备注（可选）" /></label><label htmlFor="new-bank-folder-select">所属文件夹<AppSelect id="new-bank-folder-select" ariaLabel="新题库所属文件夹" value={folderId} onValueChange={setFolderId} options={[{ value: "unfiled", label: "未分组" }, ...folders.map((folder) => ({ value: folder.id, label: folder.name }))]} /></label><label>识别颜色<span className="color-field"><input type="color" value={color} onChange={(event) => setColor(event.target.value)} /><em>{color}</em></span></label>{error && <p className="form-error" role="alert">{error}</p>}</div><footer><button disabled={busy} onClick={onClose}>取消</button><button className="primary" disabled={!name.trim() || busy} onClick={() => void createBank()}>{busy ? "创建中…" : "创建并添加题目"}</button></footer></section></div></ModalPortal>;
}

export function BankEditDialog({ bank, folders, onClose, onSaved }: { bank: Bank; folders: BankFolder[]; onClose: () => void; onSaved: (name: string) => void }) {
  const [name, setName] = useState(bankTitle(bank)); const [description, setDescription] = useState(bank.description ?? ""); const [folderId, setFolderId] = useState(bank.folderId ?? "unfiled"); const [color, setColor] = useState(bank.color ?? "#dfe9e2");
  return <ModalPortal><div className="simple-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="simple-dialog"><header><div><span className="section-kicker">题库资料</span><h2>编辑题库</h2></div><button className="icon-button" aria-label="关闭编辑题库" onClick={onClose}><X size={17} /></button></header><div><label>展示名称<input value={name} onChange={(event) => setName(event.target.value)} /><small>系统原名保持为“{bank.name}”，不会影响同步识别。</small></label><label>题库说明<textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="用途、范围或备注" /></label><label htmlFor="bank-folder-select">所属文件夹<AppSelect id="bank-folder-select" ariaLabel="所属文件夹" value={folderId} onValueChange={setFolderId} options={[{ value: "unfiled", label: "未分组" }, ...folders.map((folder) => ({ value: folder.id, label: folder.name }))]} /></label><label>识别颜色<span className="color-field"><input type="color" value={color} onChange={(event) => setColor(event.target.value)} /><em>{color}</em></span></label></div><footer><button onClick={onClose}>取消</button><button className="primary" disabled={!name.trim()} onClick={async () => { const saved = await saveBank(bank.id, { displayName: name, description, folderId: folderId === "unfiled" ? undefined : folderId || undefined, color, sortOrder: bank.sortOrder }); onSaved(bankTitle(saved)); }}>保存题库</button></footer></section></div></ModalPortal>;
}

export function FolderDialog({ folder, onClose, onSaved }: { folder?: BankFolder; onClose: () => void; onSaved: (name: string) => void }) {
  const [name, setName] = useState(folder?.name ?? ""); const [description, setDescription] = useState(folder?.description ?? "");
  return <ModalPortal><div className="simple-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="simple-dialog small"><header><div><span className="section-kicker">题库分组</span><h2>{folder ? "编辑文件夹" : "新建文件夹"}</h2></div><button className="icon-button" aria-label="关闭文件夹编辑" onClick={onClose}><X size={17} /></button></header><div><label>文件夹名称<input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：送电线路工" /></label><label>说明<textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="可选" /></label></div><footer><button onClick={onClose}>取消</button><button className="primary" disabled={!name.trim()} onClick={async () => { const saved = await saveBankFolder({ id: folder?.id, name, description }); onSaved(saved.name); }}>保存文件夹</button></footer></section></div></ModalPortal>;
}
