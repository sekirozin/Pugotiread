import fs from 'node:fs/promises';
import path from 'node:path';
import type { Library } from '../shared/types.js';
import { store } from './store.js';

async function fileKey(library: Library, id: string): Promise<string | null> {
  if(!id.startsWith(library.id+':'))return null;
  const relative=Buffer.from(id.slice(library.id.length+1),'base64url').toString('utf8');
  if(!relative.toLowerCase().endsWith('.pdf'))return null;
  const root=await fs.realpath(library.path).catch(()=>null);
  if(!root)return null;
  const target=await fs.realpath(path.resolve(root,relative)).catch(()=>null);
  if(!target?.startsWith(root+path.sep))return null;
  const stat=await fs.stat(target).catch(()=>null);
  return stat?.isFile()?`${stat.dev}:${stat.ino}:${stat.birthtimeMs}`:null;
}

/** Follow filesystem renames in the same library, without guessing from PDF names. */
export async function reconcilePdfLocation(library:Library,contentId:string):Promise<string> {
  const key=await fileKey(library,contentId);
  if(!key)return contentId;
  // Track ordinary PDFs too: bookmarks must survive moving a book into a system folder.
  if(store.pdfLocation(contentId)) { store.rememberPdfLocation(contentId,key); return contentId; }
  const old=store.pdfLocationsByFileKey(key).find(item=>item.contentId.startsWith(library.id+':'));
  if(old){
    if(await fileKey(library,old.contentId))return old.contentId; // Keep aliases behind the source permissions.
    store.renamePdfReferences(old.contentId,contentId);
  }
  store.rememberPdfLocation(contentId,key);
  return contentId;
}

/** Non-PDF IDs use different path semantics and are left to their existing scanners. */
export async function pdfLocationMissing(library:Library, contentId:string):Promise<boolean> {
  const relative=Buffer.from(contentId.slice(contentId.indexOf(':')+1),'base64url').toString('utf8');
  return relative.toLowerCase().endsWith('.pdf') && !await fileKey(library,contentId);
}
