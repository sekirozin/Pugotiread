import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ContentItem, Library, RpgDetails, User } from '../shared/types.js';
import { store } from './store.js';
import { readJson, sendJson } from './http.js';
import { reconcilePdfLocation } from './pdf-locations.js';
import { getContentPagePath } from './media.js';
import { formRevision } from './pdf-forms.js';

/** Called only after library and document visibility have been checked. */
export async function handleRpg(req: IncomingMessage, res: ServerResponse, user: User, library: Library, content: ContentItem, contents: ContentItem[]): Promise<void> {
  const data = await store.read();
  const documents = store.rpgDocuments();
  const document = documents.find(item => item.contentId === content.id) ?? null;
  const copy = store.pdfFormCopies().find(item => item.contentId === content.id) ?? null;
  const canManage = user.role === 'admin' || copy?.ownerUserId === user.id;
  const users = data.users.filter(person => person.role === 'admin' || person.allowedLibraryIds.includes(library.id));
  const visible = contents.filter(item => store.canAccessPdfContent(item.id, user));
  const byId = new Map(visible.map(item => [item.id, item]));
  const availableDocuments = documents.filter(item => byId.has(item.contentId));
  const links = store.rpgLinks();

  if (req.method === 'PATCH') {
    if (!canManage) { sendJson(res,403,{error:'Apenas o proprietário ou administrador pode alterar estas propriedades.'}); return; }
    if (req.headers['sec-fetch-site'] === 'cross-site') { sendJson(res,403,{error:'Origem inválida.'}); return; }
    try {
      const body = await readJson<Record<string, unknown>>(req);
      if (copy) {
        const ownerUserId = user.role === 'admin' && typeof body.ownerUserId === 'string' ? body.ownerUserId : copy.ownerUserId;
        if (!users.some(person => person.id === ownerUserId)) throw new Error('O proprietário precisa ter acesso à biblioteca.');
        const visibility = body.visibility ?? copy.visibility;
        if (!['private','shared','public'].includes(String(visibility))) throw new Error('Visibilidade inválida.');
        const shared = body.sharedWithUserIds ?? copy.sharedWithUserIds;
        if (!Array.isArray(shared) || shared.some(id => typeof id !== 'string' || !users.some(person => person.id === id))) throw new Error('Usuários de compartilhamento inválidos.');
        const moduleId = body.moduleId === undefined ? copy.moduleId ?? null : body.moduleId || null;
        if (moduleId && !availableDocuments.some(item => item.id === moduleId && item.role === 'module')) throw new Error('Módulo inválido para esta biblioteca.');
        // A viewer cannot transfer ownership or change sharing, even for public sheets.
        store.updatePdfFormCopy(content.id,{ownerUserId,visibility:String(visibility),sharedWithUserIds:shared,system:copy.system});
        store.setPdfCopyModule(content.id,moduleId as string | null);
      } else {
        if (user.role !== 'admin') { sendJson(res,403,{error:'Apenas administradores podem organizar módulos e modelos.'}); return; }
        if (body.role === 'sheet') {
          if(typeof body.ownerUserId !== 'string' || !users.some(person=>person.id===body.ownerUserId))throw new Error('Selecione um proprietário com acesso à biblioteca.');
          const moduleId=body.moduleId || null;
          if(moduleId && !availableDocuments.some(item=>item.id===moduleId && item.role==='module' && item.contentId!==content.id))throw new Error('Módulo inválido.');
          const source=await getContentPagePath(library,content.id,0);
          if(!source)throw new Error('PDF não encontrado.');
          const revision=await formRevision(source);
          store.setRpgDocument(content.id,null,[]);
          store.registerPdfCopy(content.id,content.id,revision,body.ownerUserId,content.system ?? '');
          store.setPdfCopyModule(content.id,moduleId as string | null);
          await reconcilePdfLocation(library,content.id);
          sendJson(res,200,{ok:true});return;
        }
        if (body.role !== 'module' && body.role !== 'template' && body.role !== null) throw new Error('Tipo de material inválido.');
        const templates = body.templateIds ?? [];
        if (!Array.isArray(templates) || templates.some(id => !availableDocuments.some(item => item.id === id && item.role === 'template' && item.contentId !== content.id))) throw new Error('Modelo inválido para esta biblioteca.');
        store.setRpgDocument(content.id,body.role,templates);
      }
      await reconcilePdfLocation(library,content.id);
      sendJson(res,200,{ok:true});
    } catch (error) { sendJson(res,400,{error:error instanceof Error ? error.message : 'Não foi possível salvar.'}); }
    return;
  }
  if (req.method !== 'GET') { sendJson(res,405,{error:'Método inválido.'}); return; }
  const templateIds = links.filter(link => link.moduleId === document?.id).map(link => link.templateId);
  const moduleIds = new Set(links.filter(link => link.templateId === document?.id).map(link => link.moduleId));
  if (copy?.moduleId) moduleIds.add(copy.moduleId);
  const sheets = store.pdfFormCopies().filter(item => document?.role === 'module'
    ? item.moduleId === document.id
    : document?.role === 'template' ? item.sourceId === content.id : false);
  const details: RpgDetails = {
    document,
    documents: availableDocuments.map(item => ({...item,title:byId.get(item.contentId)!.title})),
    templateIds,
    templates: availableDocuments.filter(item => templateIds.includes(item.id)).map(item => byId.get(item.contentId)!),
    modules: availableDocuments.filter(item => moduleIds.has(item.id)).map(item => byId.get(item.contentId)!),
    mySheets: sheets.filter(item => item.ownerUserId === user.id && byId.has(item.contentId)).map(item => byId.get(item.contentId)!),
    sharedSheets: sheets.filter(item => item.ownerUserId !== user.id && byId.has(item.contentId) && (item.visibility==='public' || item.visibility==='shared' && item.sharedWithUserIds.includes(user.id))).map(item => byId.get(item.contentId)!),
    copy: canManage ? copy : null,
    canManage,
    users: canManage ? users.map(person => ({id:person.id,displayName:person.displayName || person.username})) : []
  };
  sendJson(res,200,details);
}
