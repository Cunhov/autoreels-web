import type { IgActionDraft, IgTrigger } from "./types";
export type EditorTemplate = "comment_link" | "dm_response" | "catalog" | "sequence" | "advanced";
export const EDITOR_TEMPLATES: { id: EditorTemplate; title: string; description: string; trigger: IgTrigger; name: string }[] = [
 {id:"comment_link",title:"Comentário → link privado",description:"Responda ao comentário e envie um link no privado.",trigger:"comment",name:"Comentário → link"},
 {id:"dm_response",title:"Resposta no Direct",description:"Responda mensagens diretas com texto automático.",trigger:"dm",name:"Resposta no Direct"},
 {id:"catalog",title:"Apresentar catálogo",description:"Identifique o interesse e envie informações do catálogo.",trigger:"dm",name:"Apresentar catálogo"},
 {id:"sequence",title:"Iniciar sequência",description:"Direcione a conversa para uma sequência configurada.",trigger:"dm",name:"Iniciar sequência"},
 {id:"advanced",title:"Personalizada",description:"Comece com todos os controles disponíveis.",trigger:"comment",name:"Nova automação"},
];
export function actionsForTemplate(id:EditorTemplate): IgActionDraft[] | null {
 if(id==="comment_link")return [draft("public_comment_reply",0),draft("private_reply",1)];
 if(id==="dm_response")return [draft("dm_text",0)];
 if(id==="catalog")return [draft("dm_text",0)];
 if(id==="sequence")return [draft("start_sequence",0)];
 return null;
}
function draft(type:IgActionDraft["type"],position:number):IgActionDraft{return {position,type,delaySeconds:0,textVariants:[""],buttons: type==="private_reply"?[{type:"web_url",title:"Ver detalhes",url:""}]:[],quickReplies:[],mediaUrl:"",tag:"",sequenceId:"",webhookId:"",aiPrompt:"",trackClicks:false};}
