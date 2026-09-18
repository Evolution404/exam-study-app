import type { CanonicalState } from "../db/types";
import type { ChangeSetMutation } from "./change-set-types";
import {
  byId, byKey, byQuestionId, clone, ensureAsset, ensureBank, ensureFolder, ensureQuestion, fail,
  membershipKey, putTombstone, rejectTombstoned, removeMembership, removeTombstone,
  setById, setByKey, setByQuestionId, uniqueStrings,
} from "./change-set-projection-core";
import { updateBankDeleteCascade, updateQuestionDeleteCascade, updateQuestionsBulkDeleteCascade } from "./change-set-cascade";

export interface MutationContext {
  createdAt: string;
  deviceId: string;
  eventId: string;
  localSequence: number;
}

export function applyEntityMutation(state: CanonicalState, mutation: ChangeSetMutation, context: MutationContext): boolean {
  switch (mutation.kind) {
    case "bank.create":
      rejectTombstoned(state, "bank", mutation.bank.id);
      if (byId(state.banks, mutation.bank.id)) fail(`题库 ${mutation.bank.id} 已存在`);
      if (mutation.bank.folderId) ensureFolder(state, mutation.bank.folderId);
      state.banks.push(clone(mutation.bank));
      return true;
    case "bank.update":
      ensureBank(state, mutation.bank.id);
      if (mutation.bank.folderId) ensureFolder(state, mutation.bank.folderId);
      setById(state.banks, mutation.bank, false);
      return true;
    case "bank.reorder": {
      const ids = uniqueStrings(mutation.bankIds);
      if (ids.length !== mutation.bankIds.length) fail("题库排序包含重复 id");
      ids.forEach((id) => ensureBank(state, id));
      ids.forEach((id, index) => {
        const bank = ensureBank(state, id);
        setById(state.banks, {
          ...bank,
          sortOrder: index,
          ...(mutation.folderId !== undefined ? { folderId: mutation.folderId } : {}),
          ...(mutation.updatedAt ? { updatedAt: mutation.updatedAt } : {}),
        }, false);
      });
      return true;
    }
    case "bank.delete":
    case "bank.delete.cascade": {
      const bank = ensureBank(state, mutation.bankId);
      const hasDependencies = state.memberships.some((row) => row.bankId === bank.id)
        || state.practiceRunSources.some((row) => row.bankId === bank.id)
        || state.reviewRoundBanks.some((row) => row.bankId === bank.id);
      if (hasDependencies && mutation.kind === "bank.delete" && !mutation.cascade) {
        fail(`题库 ${bank.id} 仍有关联，必须 cascade 删除`);
      }
      updateBankDeleteCascade(state, bank.id, mutation.deletedAt ?? context.createdAt, context.deviceId, context.eventId, context.localSequence);
      return true;
    }
    case "bankFolder.save":
      rejectTombstoned(state, "bankFolder", mutation.folder.id);
      setById(state.bankFolders, mutation.folder);
      removeTombstone(state, "bankFolder", mutation.folder.id);
      return true;
    case "bankFolder.delete":
      ensureFolder(state, mutation.folderId);
      if (state.banks.some((bank) => bank.folderId === mutation.folderId)) fail(`文件夹 ${mutation.folderId} 仍被题库使用`);
      state.bankFolders = state.bankFolders.filter((row) => row.id !== mutation.folderId);
      putTombstone(state, "bankFolder", mutation.folderId, mutation.deletedAt ?? context.createdAt, context.deviceId, context.eventId, context.localSequence);
      return true;
    case "question.upsert":
      rejectTombstoned(state, "question", mutation.question.id);
      for (const block of [...mutation.question.content, ...mutation.question.options.flat()]) {
        if (block.type === "image") ensureAsset(state, block.assetId);
      }
      setById(state.questions, mutation.question);
      removeTombstone(state, "question", mutation.question.id);
      return true;
    case "question.delete":
    case "question.delete.cascade": {
      const question = ensureQuestion(state, mutation.questionId);
      const hasDependencies = state.memberships.some((row) => row.questionId === question.id)
        || state.attempts.some((row) => row.questionId === question.id)
        || state.notes.some((row) => row.questionId === question.id)
        || state.practiceRunItems.some((row) => row.questionId === question.id)
        || state.reviewRoundItems.some((row) => row.questionId === question.id)
        || state.questionGroupItems.some((row) => row.questionId === question.id);
      if (hasDependencies && mutation.kind === "question.delete" && !mutation.cascade) {
        fail(`题目 ${question.id} 仍有学习记录或关联，必须 cascade 删除`);
      }
      updateQuestionDeleteCascade(state, question.id, mutation.deletedAt ?? context.createdAt, context.deviceId, context.eventId, context.localSequence);
      return true;
    }
    case "question.split":
      ensureQuestion(state, mutation.originalQuestionId);
      rejectTombstoned(state, "question", mutation.clone.id);
      if (byId(state.questions, mutation.clone.id)) fail(`分裂目标题目 ${mutation.clone.id} 已存在`);
      for (const membership of mutation.memberships) {
        ensureBank(state, membership.bankId);
        if (membership.questionId !== mutation.clone.id) fail(`分裂关系 ${membership.key} 未指向 clone`);
      }
      for (const key of mutation.deletedMembershipKeys ?? []) {
        removeMembership(state, key);
        putTombstone(state, "membership", key, context.createdAt, context.deviceId, context.eventId, context.localSequence);
      }
      state.questions.push(clone(mutation.clone));
      for (const membership of mutation.memberships) {
        if (byKey(state.memberships, membership.key)) fail(`题库关系 ${membership.key} 已存在`);
        state.memberships.push(clone(membership));
      }
      if (mutation.note) setByQuestionId(state.notes, mutation.note);
      return true;
    case "question.import": {
      rejectTombstoned(state, "bank", mutation.bank.id);
      if (byId(state.banks, mutation.bank.id)) setById(state.banks, mutation.bank, false);
      else state.banks.push(clone(mutation.bank));
      for (const asset of mutation.images ?? []) {
        if (!applyEntityMutation(state, { kind: "image.asset.save", asset }, context)) fail("图片资产写入失败");
      }
      const seen = new Set<string>();
      for (const question of mutation.questions) {
        if (seen.has(question.id)) fail(`导入题目 ${question.id} 重复`);
        seen.add(question.id);
        rejectTombstoned(state, "question", question.id);
        const existing = byId(state.questions, question.id);
        if (existing && existing.contentFingerprint !== question.contentFingerprint) fail(`导入题目 ${question.id} 与现有内容冲突`);
        if (!existing) state.questions.push(clone(question));
      }
      for (const membership of mutation.memberships) {
        ensureQuestion(state, membership.questionId);
        ensureBank(state, membership.bankId);
        if (membership.key !== membershipKey(membership.bankId, membership.questionId)) fail(`导入关系 ${membership.key} 不是 canonical key`);
        setByKey(state.memberships, membership);
        removeTombstone(state, "membership", membership.key);
      }
      return true;
    }
    case "question.bulk.upsert":
      for (const question of mutation.questions) applyEntityMutation(state, { kind: "question.upsert", question }, context);
      return true;
    case "question.bulk.delete":
      if (!mutation.cascade) {
        for (const questionId of mutation.questionIds) {
          applyEntityMutation(state, { kind: "question.delete", questionId, deletedAt: mutation.deletedAt, cascade: mutation.cascade }, context);
        }
      } else {
        updateQuestionsBulkDeleteCascade(state, mutation.questionIds, mutation.deletedAt ?? context.createdAt, context.deviceId, context.eventId, context.localSequence);
      }
      return true;
    case "membership.save": {
      rejectTombstoned(state, "membership", mutation.membership.key);
      ensureBank(state, mutation.membership.bankId);
      ensureQuestion(state, mutation.membership.questionId);
      const canonical = membershipKey(mutation.membership.bankId, mutation.membership.questionId);
      if (canonical !== mutation.membership.key) fail(`题库关系 key ${mutation.membership.key} 不是 canonical key`);
      setByKey(state.memberships, mutation.membership);
      removeTombstone(state, "membership", mutation.membership.key);
      return true;
    }
    case "membership.remove": {
      const key = mutation.key ?? membershipKey(mutation.bankId, mutation.questionId);
      const current = removeMembership(state, key);
      if (current.bankId !== mutation.bankId || current.questionId !== mutation.questionId) fail(`题库关系 ${key} 与目标不一致`);
      putTombstone(state, "membership", key, mutation.removedAt ?? context.createdAt, context.deviceId, context.eventId, context.localSequence);
      return true;
    }
    case "membership.bulk.save":
      for (const membership of mutation.memberships) applyEntityMutation(state, { kind: "membership.save", membership }, context);
      return true;
    case "membership.bulk.remove":
      for (const key of mutation.keys) {
        const current = byKey(state.memberships, key);
        if (!current) fail(`题库关系 ${key} 不存在`);
        applyEntityMutation(state, { kind: "membership.remove", bankId: current.bankId, questionId: current.questionId, key, removedAt: mutation.removedAt }, context);
      }
      return true;
    case "image.asset.save": {
      rejectTombstoned(state, "imageAsset", mutation.asset.id);
      const old = byId(state.imageAssets, mutation.asset.id);
      if (old && JSON.stringify(old) !== JSON.stringify(mutation.asset)) fail(`图片资产 ${mutation.asset.id} 不可变内容冲突`);
      if (!old) state.imageAssets.push(clone(mutation.asset));
      return true;
    }
    case "image.asset.delete":
      ensureAsset(state, mutation.assetId);
      if (state.questions.some((question) => [...question.content, ...question.options.flat()].some((block) => block.type === "image" && block.assetId === mutation.assetId))) {
        fail(`图片资产 ${mutation.assetId} 仍被题目引用`);
      }
      state.imageAssets = state.imageAssets.filter((row) => row.id !== mutation.assetId);
      putTombstone(state, "imageAsset", mutation.assetId, mutation.deletedAt ?? context.createdAt, context.deviceId, context.eventId, context.localSequence);
      return true;
    case "note.upserted":
      rejectTombstoned(state, "note", mutation.note.questionId);
      ensureQuestion(state, mutation.note.questionId);
      setByQuestionId(state.notes, mutation.note);
      return true;
    case "note.deleted":
      ensureQuestion(state, mutation.questionId);
      if (!byQuestionId(state.notes, mutation.questionId)) fail(`解析 ${mutation.questionId} 不存在`);
      state.notes = state.notes.filter((note) => note.questionId !== mutation.questionId);
      putTombstone(state, "note", mutation.questionId, mutation.deletedAt ?? context.createdAt, context.deviceId, context.eventId, context.localSequence);
      return true;
    default:
      return false;
  }
}
