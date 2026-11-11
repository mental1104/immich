import { photoEditGraph, type PhotoEditVersion } from './photo-edit-advice.service';

/** @param id 合成版本 ID。@param parentId 直接父版本或原片。@returns 完整历史行。 */
function revision(id: string, parentId: string | null): PhotoEditVersion {
  return {
    id,
    parentId,
    kind: 'upload',
    editor: 'photomator',
    filename: id + '.jpg',
    note: '',
    state: 'ready',
    analyzing: false,
    createdAt: '2026-11-11T00:00:00.000Z',
    committedAt: null,
  };
}

/** 同一原片允许从已保存版本重新开分支，未提交或其他软件的版本也都能回看。 */
it('follows parent revisions independently of chronological upload order', () => {
  const rows = photoEditGraph([
    revision('first', null),
    revision('alternative', null),
    revision('second', 'first'),
    revision('branch', 'first'),
    revision('third', 'second'),
  ]);
  expect(rows.map(({ version, depth, last }) => [version.id, depth, last])).toEqual([
    ['first', 0, false],
    ['second', 1, false],
    ['third', 2, true],
    ['branch', 1, true],
    ['alternative', 0, true],
  ]);
});
