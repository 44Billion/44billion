import{b as Me,c as le,d as Ke}from"./chunk-FZKW7XBH.js";import{c as Ie,d as xe,e as ce,f as Pe,o as we,p as ue}from"./chunk-UPSCYAKA.js";import{a as H,e as F,f as Se,g as Te,j as ge,l as ie}from"./chunk-4YEM5IRY.js";import{a as q,b as N,f as ee}from"./chunk-LLMC3MZB.js";import{g as D,i as me,j as Ae,n as U,o as ae,p as X,q as Be,s as Z,v as M}from"./chunk-5XJKKVB7.js";var $e="0123456789abcdefghijklmnopqrstuvwxyz",qe=BigInt($e.length),ze=$e[0],Ye=new Map([...$e].map((t,e)=>[t,BigInt(e)]));function Qe(t,e=0){return Oe(H(t),e)}function Oe(t,e=0){return Je(Ze(t),e)}function kt(t,e=0){return Qe(Se(t),e)}function Re(t){return Xe(Ge(t))}function Ge(t){if(typeof t!="string")throw new Error("Input must be a string.");let e=0n;for(let s of t){let n=Ye.get(s);if(n===void 0)throw new Error(`Invalid character in Base36 string: ${s}`);e=e*qe+n}return e}function Je(t,e){if(typeof t!="bigint")throw new Error("Input must be a BigInt.");if(t<0n)throw new Error("Can't be signed BigInt");return t.toString(36).padStart(e,ze)}function Xe(t){if(typeof t!="bigint")throw new Error("Input must be a BigInt.");if(t<0n)throw new Error("Can't be signed BigInt");let e=t.toString(16);return e.length%2!==0&&(e=`0${e}`),e}function Ze(t){if(typeof t!="string")throw new Error("Input must be a string.");return BigInt(`0x${t}`)}function Le(t){if(t instanceof Error)return t;let e=new Error(t.message);return e.name=t.name||"Error",e.stack=t.stack,Object.assign(e,t.context||{}),e}var Ue=!1,et=Ue?"http://":"https://",tt=Ue?"localhost:10000":"44billion.net",Bt=`${et}${tt}`;var te={};function st(){return Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2)}function nt(t,e,s=5e3){if(!t||!e)throw new Error("Missing request id or code");let{promise:n,resolve:_,reject:a}=Promise.withResolvers();te[t]={resolve:_,reject:a};let i;return s!=null&&(s>0?i=setTimeout(()=>{te[t]?.reject?.(`Timeout for ${e} reqId: ${t}`)},s):te[t]?.reject?.(`Timeout for ${e} reqId: ${t}`)),n.finally(()=>{clearTimeout(i),delete te[t]})}function ot(t){let e=te[t.data.reqId];if(!e){console.log(`Unhandled response for reqId ${t.data.reqId} (may have timed out)`,JSON.stringify(t.data));return}t.data.error?e.reject(Le(t.data.error)):e.resolve({payload:t.data.payload,isLast:t.data.isLast??!0,ports:t.ports})}var rt=((t,e=new WeakMap,s=new FinalizationRegistry(n=>n.abort()))=>n=>{let _=n instanceof MessagePort;if(t=_?n:globalThis,e.has(t))return;let a=new AbortController;e.set(t,a),t.addEventListener("message",async i=>{if(i.data.code==="REPLY")return ot(i)},{signal:a.signal}),_&&t.start(),s.register(t,a)})();async function be(t,e,s,n){if(!e.code&&!("payload"in e))throw new Error("Missing args");(!s||typeof s!="object")&&(s={targetOrigin:s,transfer:n}),rt(t);let _=st(),a=nt(_,e.code,s.timeout);return t.postMessage({...e,reqId:_},s),a.then(({payload:i,ports:c})=>({code:e.code,payload:i,ports:c})).catch(i=>({code:e.code,payload:null,error:i}))}function I(t,e,s,n){if(!("payload"in e)&&!("error"in e))throw new Error("Missing args");if((!s||typeof s!="object")&&(s={targetOrigin:s,transfer:n}),s.targetOrigin??=t.origin,!s.to&&!t.source)throw new Error("Set port to options.to");s.to??=t.source,s.to.postMessage({...e,reqId:t.data.reqId,code:"REPLY"},s)}function C(t,e,s,n){if(!e.code||!("payload"in e)&&!("error"in e))throw new Error("Missing args");(!s||typeof s!="object")&&(s={targetOrigin:s,transfer:n}),t.postMessage(e,s)}async function at(t,e,s){try{let n=s.map(r=>we(r)),_=new Blob(n,{type:e.contentType}),a=new FileReader,c=await new Promise((r,o)=>{a.onload=()=>r(a.result),a.onerror=o,a.readAsDataURL(_)}),g={fx:e.rootHash,url:c};return q(localStorage,`session_appById_${t}_icon`,g),g}catch(n){console.log("Failed to update icon storage:",n)}}async function Wt(t,e,s,n,_,a,i,c,g,r,o,{signal:d,isSingleNapp:w=!1,onFileNotCached:u=null}={}){let p=Re(t),$=F(p)===JSON.parse(localStorage.getItem("session_defaultUserPk")),K=new URL(JSON.parse(localStorage.getItem("config_vaultUrl")));document.querySelector(`iframe[src="${K.href.replace(/\/$/,"")}"]`)||console.warn("Vault iframe not found");let x=ge(e),R=ue.create(e,x);R.catch(()=>{});let y;try{y=d?await Promise.race([R,new Promise((f,P)=>{if(d.aborted)return P(new Error("aborted"));d.addEventListener("abort",()=>P(new Error("aborted")),{once:!0})})]):await R}catch{if(d?.aborted)return;u&&u();return}w&&y.updateSiteManifestMetadata({lastOpenedAsSingleNappAt:Date.now()});let v=null,B=null;d?.addEventListener("abort",()=>{v&&(v.close(),v=null),B&&(B.close(),B=null)},{once:!0});let T,z=location.origin.replace("//",`//${s}.`);window.addEventListener("message",f=>{f.data.code!=="TRUSTED_IFRAME_READY"||f.source!==_.contentWindow||f.origin!==z||(T?.abort(),T=new AbortController,v&&v.close(),v=f.ports[0],Fe(v,AbortSignal.any([d,T.signal])),Y(s,n))},{signal:d});let pe=!1;function Y(f,P=""){if(pe)return;pe=!0;let m;window.addEventListener("message",h=>{h.data.code!=="APP_IFRAME_READY"||h.source!==a.contentWindow||h.origin!==z||(m?.abort(),m=new AbortController,B&&B.close(),B=h.ports[0],Ve(B,AbortSignal.any([d,m.signal])))},{signal:d});let l=window.location.host;i(`//${f}.${l}${P}`)}function Fe(f,P){f.addEventListener("message",async m=>{switch(m.data.code){case"STREAM_APP_FILE":{let l=(h,b=new Error("FILE_NOT_CACHED"))=>(h&&console.log(h),u&&b.message!=="HTML_FILE_NOT_CACHED"&&u(m.data.payload.pathname),I(m,{error:b,isLast:!0},{to:f}));try{let h=await y.getFileCacheStatus(m.data.payload.pathname,null,{withMeta:!0});if(!h.isCached)if(h.isHtml)l(null,new Error("HTML_FILE_NOT_CACHED"));else{let{fileRootHash:A,total:E}=h,k=0,S=!1,O=!1,Q=!1,ye=async()=>{if(!(S||O||Q)){Q=!0;try{for(;!S&&!O;){let L=await xe(e,A,{fromPos:k,toPos:k});if(L.length===0)break;let G=L[0];if(E===null){let oe=G.evt.tags.find(re=>re[0]==="c"&&re[1].startsWith(`${A}:`)),j=parseInt(oe?.[2]);!Number.isNaN(j)&&j>0&&(E=j)}let J=E!=null&&k===E-1;I(m,{payload:{content:G.evt.content,...k===0&&{contentType:h.contentType}},isLast:J},{to:f}),k++,J&&(O=!0)}}catch(L){S=!0,l(L)}finally{Q=!1}}},je=async({progress:L,chunkIndex:G,total:J,error:oe})=>{if(S||O)return;if(oe){S=!0;let he=c(),{[m.data.payload.pathname]:He,..._e}=he;return c(_e),l(oe)}J&&E===null&&(E=J);let j=m.data.payload.pathname,re=c();c({...re,[j]:{progress:L,totalByteSizeEstimate:E?(E-1)*51e3:0}}),L>=100&&setTimeout(()=>{let he=c(),{[j]:He,..._e}=he;c(_e)},1e3),typeof G=="number"?G===k&&await ye():await ye()};try{if(await ye(),!O&&!S)return y.cacheFile(m.data.payload.pathname,h.pathTag,je)}catch(L){return l(L)}}let b=0;for await(let A of ce(e,y.getFileRootHash(m.data.payload.pathname)))I(m,{payload:{content:A.evt.content,...b===0&&{contentType:h.contentType}},isLast:++b===h.total},{to:f})}catch(h){return l(h,h)}break}}},{signal:P}),f.start(),C(f,{code:"BROWSER_READY",payload:null})}let V=new Map,ne=new Map;async function fe(f,P,{timeoutMs:m=1750}={}){if(V.has(f))return V.get(f);ne.has(f)||ne.set(f,{icon:!1,name:!1,promise:null});let l=ne.get(f);if(l.promise)return l.promise;P??=ge(f);let h=await ue.create(f,P),b={id:f,napp:Me(P)},A=[];!("icon"in b)&&!l.icon&&(l.icon=!0,A.push(h.getIcon().then(k=>k&&(b.icon=k)).finally(()=>{l.icon=!1}))),!("name"in b)&&!l.name&&(l.name=!0,A.push(h.getName().then(k=>k&&(b.name=k)).finally(()=>{l.name=!1})));let E=(async()=>{if(A.length>0){let k=Promise.all(A).then(()=>V.set(f,b));await Promise.race([k,new Promise(S=>setTimeout(S,m))])}return V.set(f,b),ne.delete(f),b})();return l.promise=E,E}function Ve(f,P){f.addEventListener("message",async m=>{switch(m.data.code){case"OPEN_APP":{let l;try{let{href:h}=m.data.payload,A=new URL(h,self.location.origin).pathname,E=/^\/(\+{1,3}[a-zA-Z0-9]{48,})/,k=A.match(E);if(!k){console.error("Invalid app URL format:",h);break}let S=k[1],O=le(S);l=ie(O);let Q=await fe(l,O,{timeoutMs:0});await r({app:await fe(e,x),name:"openApp",eKind:null,meta:{targetApp:Q}}),o(h)}catch(h){let b=!1;for(let A of JSON.parse(localStorage.getItem("session_workspaceKeys"))??[])if(b=Array.isArray(JSON.parse(localStorage.getItem(`session_workspaceByKey_${A}_appById_${l}_appKeys`))),b)break;b||(q(localStorage,`session_appById_${l}_icon`,void 0),q(localStorage,`session_appById_${l}_name`,void 0),q(localStorage,`session_appById_${l}_description`,void 0),q(localStorage,`session_appById_${l}_relayHints`,void 0),await(await ue.create(l)).clearAppFiles()),console.error("Error in OPEN_APP handler:",h)}break}case"NIP07":{if(["peek_public_key","get_public_key"].includes(m.data.payload.method)&&m.data.payload.ns[0]===""&&m.data.payload.ns.length===1){I(m,{payload:p},{to:f});break}let{ns:l,method:h,params:b=[]}=m.data.payload,A=await fe(e,x,{timeoutMs:0}),E;try{E=await ut(g,p,l,h,b,{isDefaultUser:$,requestPermission:r,app:A})}catch(k){E={error:k}}I(m,E,{to:f});break}case"WINDOW_NAPP":{it(m);break}case"STREAM_APP_ICON":{try{let l=y.getFaviconMetadata();if(!l){I(m,{error:new Error("No favicon"),isLast:!0},{to:f});break}let h=await y.getFileCacheStatus(null,l.tag,{withMeta:!0});if(h.isCached||(await y.cacheFile(null,l.tag),h=await y.getFileCacheStatus(null,l.tag,{withMeta:!0})),y.service==="blossom"){let S=Pe.create();for await(let O of ce(e,l.rootHash))S.update(we(O.evt.content));if(H(S.digest())!==l.rootHash){l.rootHash&&await Ie(e,l.rootHash),I(m,{error:new Error("Icon hash mismatch"),isLast:!0},{to:f});break}}let A=JSON.parse(localStorage.getItem(`session_appById_${e}_icon`))?.fx!==l.rootHash,E=[],k=0;for await(let S of ce(e,l.rootHash))A&&E.push(S.evt.content),I(m,{payload:{content:S.evt.content,...k===0&&{mimeType:l.mimeType||h.mimeType,contentType:l.contentType||h.contentType}},isLast:++k===h.total},{to:f});if(E.length>0){let{url:S}=await at(e,l,E);if(V.has(e)){let O=V.get(e);O.icon={fx:l.rootHash,url:S}}}}catch(l){console.log(l.stack),I(m,{error:l,isLast:!0},{to:f})}break}case"CACHE_APP_FILE":{try{let l=({progress:h,error:b})=>{if(b)u&&u(m.data.payload.pathname),I(m,{error:b,isLast:!0},{to:f});else{let A=h>=100;I(m,{payload:h,isLast:A},{to:f})}};y.cacheFile(m.data.payload.pathname,null,l)}catch(l){console.log(m.data.payload.pathname,"error:",l.stack),u&&u(m.data.payload.pathname),I(m,{error:l,isLast:!0},{to:f})}break}}},{signal:P}),f.start(),C(f,{code:"BROWSER_READY",payload:null})}}function it(t){return I(t,{error:new Error("Not implemented yet")})}var lt={getPublicKey:"readProfile",signEvent:"signEvent",nip04Encrypt:"encrypt",nip04Decrypt:"decrypt",nip44Encrypt:"encrypt",nip44Decrypt:"decrypt"};function ct(t){return lt[t]||(()=>{throw new Error(`Unknown method ${t}`)})()}async function ut(t,e,s,n,_,{isDefaultUser:a,requestPermission:i,app:c}={}){if(a)throw new Error("Please login");if(i){let d=n.includes("_")?n.replace(/_([a-z0-9])/g,(u,p)=>p.toUpperCase()):n,w=(()=>{switch(d){case"signEvent":return _?.[0]?.kind;default:return null}})();await i({app:c,name:ct(d),eKind:w,meta:{params:_}})}let{napp:g,...r}=c,o={code:"NIP07",payload:{app:{...r,id:g},pubkey:e,ns:s,method:n,params:_}};return t(o,{timeout:12e4})}function ke(){return F(dt(),43)}function dt(){let t=crypto.getRandomValues(new Uint8Array(40)),s=2n**256n-0x14551231950b75fc4402da1732fc9bebfn;return(((i,c)=>{let g=i%c;return g>=0n?g:c+g})((i=>BigInt("0x"+(H(i)||"0")))(t),s-1n)+1n).toString(16).padStart(64,"0")}var We=["+32Wp7Qdz5XIbjlzHht7GdEP8IDxk6CC90ee8lRxYjx0stjsVD8yzTguF","+3swFhu23QNl8er5yOtc8bf9ueHCdwF8CzoDUiSSwwKIWoS8Ki5TwMyeA3Js1"].map(le).map(ie);function pt(){let t=N(localStorage),e=N(sessionStorage);return Be("hardcoded_newAppIdsObj",{}),M(()=>{if(t.session_workspaceKeys$())return;let s=ke();t.session_defaultUserPk$(s),Ce({userPk:s,storage:t,tabStorage:e,isFirstTimeUser:!0})}),M(()=>{if(!t.session_workspaceKeys$())return;let s=t.session_workspaceKeys$()||[],n=t.session_defaultUserPk$();s.forEach(_=>{let a=t[`session_workspaceByKey_${_}_userPk$`]();a!=null&&a!==n&&!(t[`session_accountByUserPk_${a}_isReadOnly$`]()??!1)&&t[`session_accountByUserPk_${a}_isLocked$`](!0)})}),M(({track:s})=>{if(s(()=>t.session_workspaceKeys$().length>0))return;let n=ke();t.session_defaultUserPk$(n),Ce({userPk:n,storage:t,tabStorage:e,isFirstTimeUser:!0})}),t}function Ce({userPk:t,storage:e,tabStorage:s,isFirstTimeUser:n}){let _=We.map((c,g)=>({id:c,key:Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2),visibility:"closed",isNew:!1})),a=Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2);e.config_isSingleWindow$()===void 0&&e.config_isSingleWindow$(!1);let i=[];s[`session_workspaceByKey_${a}_openAppKeys$`](i),e[`session_workspaceByKey_${a}_userPk$`](t),_.forEach(c=>{e[`session_workspaceByKey_${a}_appById_${c.id}_appKeys$`]([c.key]),e[`session_appByKey_${c.key}_id$`](c.id),s[`session_appByKey_${c.key}_visibility$`](c.visibility),e[`session_appByKey_${c.key}_route$`]("")}),e[`session_workspaceByKey_${a}_unpinnedCoreAppIdsObj$`]({}),e[`session_workspaceByKey_${a}_pinnedAppIds$`](_.map(({id:c})=>c)),e[`session_workspaceByKey_${a}_unpinnedAppIds$`]([]),e[`session_accountByUserPk_${t}_isReadOnly$`](!0),e[`session_accountByUserPk_${t}_isLocked$`](!1),e[`session_accountByUserPk_${t}_profile$`]({npub:Ke(Te(t)),meta:{events:[]}}),e[`session_accountByUserPk_${t}_relays$`]({meta:{events:[]}}),e.session_accountUserPks$([t]),e.session_workspaceKeys$([a]),e.session_openWorkspaceKeys$([a])}async function ve(t,e,s){let n=e.session_workspaceKeys$()||[],_=e.session_openWorkspaceKeys$()||[],a=e.session_defaultUserPk$(),i=n.length===1&&n.every(o=>e[`session_workspaceByKey_${o}_userPk$`]()===a);if(t.length===0&&i)return;let c=e.session_accountUserPks$()||[],g=t.map(o=>F(o.pubkey)),r;if(t.forEach(o=>{let d=F(o.pubkey);e[`session_accountByUserPk_${d}_isReadOnly$`](r=o.isReadOnly??!1),e[`session_accountByUserPk_${d}_isLocked$`](r?!1:o.isLocked??!0),e[`session_accountByUserPk_${d}_profile$`](o.profile),e[`session_accountByUserPk_${d}_relays$`](o.relays)}),i&&g.length===1){let o=n[0],d=g[0],w=s[`session_workspaceByKey_${o}_openAppKeys$`]()||[],u=[];w.forEach(p=>{s[`session_appByKey_${p}_visibility$`]($=>($==="open"&&u.push(p),"closed"))}),s[`session_workspaceByKey_${o}_openAppKeys$`]([]),e[`session_workspaceByKey_${o}_userPk$`](d),await new Promise(p=>setTimeout(p,0)),u.forEach(p=>{s[`session_appByKey_${p}_visibility$`]("open")}),s[`session_workspaceByKey_${o}_openAppKeys$`](u),e.session_defaultUserPk$(void 0)}else{let o=g.filter(y=>!c.includes(y)),d=c.filter(y=>!g.includes(y));o.length>0&&a&&e.session_defaultUserPk$(void 0);let w=[];for(let y of d)w=w.concat(n.filter(v=>e[`session_workspaceByKey_${v}_userPk$`]()===y));let u=[];for(let y of o){let v=We.map(T=>({id:T,key:Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2),visibility:"closed",isNew:!1})),B=Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2);u.push(B),s[`session_workspaceByKey_${B}_openAppKeys$`]([]),e[`session_workspaceByKey_${B}_userPk$`](y),v.forEach(T=>{e[`session_workspaceByKey_${B}_appById_${T.id}_appKeys$`]([T.key]),e[`session_appByKey_${T.key}_id$`](T.id),s[`session_appByKey_${T.key}_visibility$`](T.visibility),e[`session_appByKey_${T.key}_route$`]("")}),e[`session_workspaceByKey_${B}_unpinnedCoreAppIdsObj$`]({}),e[`session_workspaceByKey_${B}_pinnedAppIds$`](v.map(({id:T})=>T)),e[`session_workspaceByKey_${B}_unpinnedAppIds$`]([])}let p=new Set(w),$=n.filter(y=>!p.has(y)).concat(u),K=new Set($),W=_.filter(y=>K.has(y)),x=new Set(W),R=W.concat($.filter(y=>!x.has(y)));e.session_openWorkspaceKeys$(R),e.session_workspaceKeys$($);for(let y of w){let v=e[`session_workspaceByKey_${y}_pinnedAppIds$`]()||[],B=e[`session_workspaceByKey_${y}_unpinnedAppIds$`]()||[],T=[...new Set([...v,...B])];e[`session_workspaceByKey_${y}_unpinnedCoreAppIdsObj$`](void 0),e[`session_workspaceByKey_${y}_pinnedAppIds$`](void 0),e[`session_workspaceByKey_${y}_unpinnedAppIds$`](void 0),e[`session_workspaceByKey_${y}_userPk$`](void 0),s[`session_workspaceByKey_${y}_openAppKeys$`](void 0),T.forEach(z=>{(e[`session_workspaceByKey_${y}_appById_${z}_appKeys$`]()||[]).forEach(Y=>{e[`session_appByKey_${Y}_id$`](void 0),s[`session_appByKey_${Y}_visibility$`](void 0),e[`session_appByKey_${Y}_route$`](void 0)}),e[`session_workspaceByKey_${y}_appById_${z}_appKeys$`](void 0)})}}e.session_accountUserPks$(g),c.filter(o=>!g.includes(o)).forEach(o=>{e[`session_accountByUserPk_${o}_isReadOnly$`](void 0),e[`session_accountByUserPk_${o}_isLocked$`](void 0),e[`session_accountByUserPk_${o}_profile$`](void 0),e[`session_accountByUserPk_${o}_relays$`](void 0)})}var es=D("aModal",function(){let t=ae({dialogRef$:null,render:this.props.render,shouldAlwaysDisplay$:this.props.shouldAlwaysDisplay$??this.props.shouldAlwaysDisplay??!1,isOpen$:this.props.isOpen$,close:this.props.close,afterClose:this.props.afterClose});return M(({track:e})=>{e(()=>t.isOpen$.get())?t.dialogRef$().showModal():t.dialogRef$().close()},{after:"rendering"}),this.h`
    <dialog
      ref=${t.dialogRef$}
      data-name='modal'
      closedby='any'
      onclose=${t.close}
      class="scope_g7h2g1"
    >
      <style>
        .scope_g7h2g1 {
          & /* &:modal are those opened with showModal() instead of show() */ {
            container-type: normal;
            --duration: .3s;
            /* display: none; (default) */
            transition:
              overlay var(--duration) ease-in-out allow-discrete,
              display var(--duration) ease-in-out allow-discrete;
            /* reset [popover] */
            &:focus-visible { outline: 0; }
            color: initial;
            background-color: initial;
            padding: 0;
            border: 0;
            inset: initial;
            width: initial;
            height: initial;
            overflow: initial;
            /* reset [dialog] */
            inset-inline-start: initial;
            inset-inline-end: initial;
          }

          /* &:popover-open, */ &[open] /* after dialog.showModal() */ {
            /* --modal-state: open; /* only for dialog modal */
          }

          /* &:popover-open::backdrop, */ &[open]::backdrop {
            opacity: 0.6;
            backdrop-filter: blur(1px);

            @starting-style {
              opacity: 0;
              backdrop-filter: blur(0px);
            }
          }

          &::backdrop {
            /* display: none; (default) */
            opacity: 0;
            backdrop-filter: blur(0px);
            position: absolute;
            inset: 0;
            background-color: black;
            transition:
              opacity var(--duration) ease-in-out,
              backdrop-filter var(--duration) ease-in-out,
              overlay var(--duration) ease-in-out allow-discrete,
              display var(--duration) ease-in-out allow-discrete;
          }
        }
      </style>
      <div
        data-name='modalContentContainer'
        class="scope_f82h1k"
      >
        <style>
          ${`.scope_f82h1k {
            & {
              position: fixed;
              transition: var(--duration) ease-in-out;
              border-top-right-radius: 17px; /* for scrollbar */
              overflow: hidden; /* for scrollbar */

              @media ${ee.breakpoints.desktop} {
                transition-property: bottom, transform;
                bottom: 0;
                transform: translate(-50%, 100%);
                left: 50%;
                /* @container style(:popover-open), style(--modal-state: open) { */
                .scope_g7h2g1[open] & {
                  bottom: 50%;
                  transform: translate(-50%, 50%);
                  @starting-style {
                    bottom: 0;
                    transform: translate(-50%, 100%);
                  }
                }
                border-bottom-right-radius: 17px; /* for scrollbar */
              }

              @media ${ee.breakpoints.mobile} {
                transition-property: top, transform;
                transform: translate(0, 0);
                top: 100%;
                /* @container style(:popover-open), style(--modal-state: open) { */
                .scope_g7h2g1[open] & {
                  transform: translate(0, -100%);
                  @starting-style {
                    transform: translate(0, 0);
                  }
                }
              }
            }
          }`}
        </style>
        <div
          data-name='modalContent'
          class="scope_j3k1h2"
        >
          <style>
            ${`.scope_j3k1h2 {
              & {
                overflow-y: auto;
                /*
                  https://gist.github.com/adamcbrewer/5859738
                  https://stackoverflow.com/questions/5736503/how-to-make-css3-rounded-corners-hide-overflow-in-chrome-opera
                  the scroll without this ignores border-radius
                  but it will blur content
                  mask-image: -webkit-radial-gradient(circle, white, black);
                */

                display: flex;
                flex-direction: column;
                /* background-color: white; */
                min-height: 50px; /* when there is loading (dynamic content) */

                @media ${ee.breakpoints.desktop} {
                  border-radius: 17px;
                  min-width: 400px;
                  width: 800px;
                  max-width: 90vw;
                  max-width: 90dvw;
                  max-height: 90vh; /* leave 10 for browser collapsible header */
                  max-height: 90dvh;
                }

                @media ${ee.breakpoints.mobile} {
                  border-top-left-radius: 17px;
                  border-top-right-radius: 17px;
                  width: 100vw;
                  width: 100dvw;
                  max-height: 85vh;
                  max-height: 85dvh;
                }
              }

              ${(t.shouldAlwaysDisplay$.get()||"")&&`
                content-visibility: auto;
                contain-intrinsic-width: auto 400px;
                contain-intrinsic-height: auto 200px;
              `}
            }`}
          </style>
          ${(t.shouldAlwaysDisplay$.get()||t.isOpen$.get()||"")&&(t.render?.call(this)??"")}
        </div>
      </div>
    </dialog>
  `},{useShadowDOM:!1});function Ee(t){return t?ft(t):Z("<a-modal>")}function ft(t){return Z("<a-modal>",t)}D("vaultModal",function(){let t=Ee(),e=ae(()=>({...t,shouldAlwaysDisplay$:!0,render:me(function(){return this.h`<vault-messenger-wrapper />`})}));return this.h`<a-modal props=${e} />`});D("vault-messenger-wrapper",function(){let t=N(localStorage),{config_vaultUrl$:e}=t;M(()=>{e()===void 0&&e("https://44billion.github.io/44b-vault")});let s=Ae(!1);M(async({track:_,cleanup:a})=>{let i=_(()=>e());if(!i){s(!1);return}s(!1);let c=0,g,r=new AbortController;a(()=>{clearTimeout(g),r.abort()});let o=async()=>{try{if(await fetch(i,{mode:"no-cors",signal:r.signal}),r.signal.aborted)return;s(!0)}catch{if(r.signal.aborted)return;c++;let w=Math.min(3e4,500*2**c);console.warn(`Vault unreachable, retrying in ${w}ms`),g=setTimeout(o,w)}};o()},{after:"rendering"});let{vaultPort$:n}=De({shouldInit:!0});return Ne(n),!e()||!s()?this.h``:this.h`${this.h({key:e()})`<vault-messenger />`}`});function De({shouldInit:t=!1}={}){return t?X("vaultMessenger",()=>({isWorkarounEnabled$:!0,disableStartAtVaultHomeWorkaroundThisTime(){this.isWorkarounEnabled$(!1)},isFirstRun$:!0,vaultPort$:null,vaultIframeRef$:null,vaultIframeSrc$:"about:blank",isVaultMessengerReady$:!1,widgetHeight$:0})):X("vaultMessenger")}D("vault-messenger",function(){let{isFirstRun$:t,vaultPort$:e,vaultIframeRef$:s,vaultIframeSrc$:n,isVaultMessengerReady$:_,widgetHeight$:a,isWorkarounEnabled$:i}=De();M(({cleanup:p})=>p(()=>{e(null),n("about:blank")}));let c=N(localStorage),g=N(sessionStorage),{config_vaultUrl$:r}=c,{cancelPreviousRequests:o,postVaultMessage:d}=Ne(e),w=Ee(),{isOpen$:u}=w;return M(({track:p})=>{let $=p(()=>u());t()||$||e()&&d({code:"CLOSED_VAULT_VIEW",payload:null},{instant:!0})}),M(({track:p})=>{let $=i();i(!0);let K=p(()=>!u());t()||K||!$||e()&&d({code:"OPEN_VAULT_HOME",payload:null},{instant:!0})}),M(()=>{t(!1)}),M(async({track:p,cleanup:$})=>{p(()=>r());let K=new AbortController;$(()=>{K.abort()});let W=new URL(r()).origin,x,R=()=>{x&&x.abort()},y=v=>{x=v,v&&v.signal.addEventListener("abort",()=>{x===v&&(x=null)},{once:!0})};s().addEventListener("load",()=>{setTimeout(()=>{R();let v=_t({vaultIframe:s(),vaultPort$:e,abortSignal:K.signal});y(v)},100)},{signal:K.signal}),ht({vaultIframe:s(),vaultOrigin:W,vaultPort$:e,componentSignal:K.signal,widgetHeight$:a,storage:c,tabStorage:g,stopRenderHandshake:R,vaultModalStore:w}),_(!0)},{after:"rendering"}),M(async({track:p})=>{let[$,K]=p(()=>[_(),r()]);$&&(n(K),o(new Error("Canceled due to new vault URL selection")))}),this.h`
    <style>
      #vault {
        border: none;
        width: 100%;
        height: 100%;
        display: block; /* ensure it's not inline */
      }
    </style>
    <iframe
      allow='clipboard-write;
             publickey-credentials-create;
             publickey-credentials-get'
      style=${{height:`${a()}px`}}
      id='vault'
      ref=${s}
      src=${n()}
    />
  `});var se=null,de=[],yt=50;function is(t){if(!se){de.length<yt&&de.push(t);return}C(se,t)}function ht({vaultIframe:t,vaultOrigin:e,vaultPort$:s,componentSignal:n,widgetHeight$:_,storage:a,tabStorage:i,stopRenderHandshake:c,vaultModalStore:g}){let r=null;n?.addEventListener("abort",()=>{r&&(r.close(),r=null,se=null,de.length=0)},{once:!0});let o;window.addEventListener("message",u=>{u.data.code!=="VAULT_READY"||u.source!==t.contentWindow||u.origin!==e||!u.ports[0]||(u.data.payload.accounts?ve(u.data.payload.accounts,a,i):console.log("Missing account data on vault startup"),o?.abort(),o=new AbortController,r&&r.close(),r=u.ports[0],se=r,d({vaultPort:r,signal:AbortSignal.any([n,o.signal])}),c?.(),w(r),de.splice(0).forEach(p=>C(se,p)),s(r))},{signal:n});function d({vaultPort:u,signal:p}){u.addEventListener("message",$=>{switch($.data.code){case"CHANGE_DIMENSIONS":{_($.data.payload.height);break}case"CLOSE_VAULT_VIEW":{g.close();break}case"SET_ACCOUNTS_STATE":{if(!$.data.payload.accounts){console.log("Missing account data on vault message");break}ve($.data.payload.accounts,a,i);break}}},{signal:p}),u.start()}function w(u){C(u,{code:"BROWSER_READY",payload:null})}}function _t({vaultIframe:t,vaultPort$:e,abortSignal:s}){if(s?.aborted)return null;let n=new AbortController,{signal:_}=n,a,i=()=>{n.signal.aborted||n.abort()};s&&s.addEventListener("abort",i,{once:!0}),_.addEventListener("abort",()=>{a&&clearTimeout(a)},{once:!0});let c=40,g=0,r=()=>{if(_.aborted)return;let o=t?.contentWindow;if(!o){i();return}if(C(o,{code:"RENDER",payload:null},{targetOrigin:"*"}),e()){i();return}if(g>=c){i();return}g+=1;let d=Math.min(500,50*g);a=setTimeout(r,d)};return r(),n}function Ne(t){return t!==void 0&&mt(t),X("useRequestVaultMessage")}function mt(t){let e=N(localStorage),{config_vaultUrl$:s}=e,{msgQueue$:n}=X("useRequestVaultMessage",()=>({vaultPort$:t,vaultOrigin$(){return new URL(s()).origin},msgQueue$:{waiting:[],running:[]},postVaultMessage(r){if(!this.vaultPort$())return Promise.reject(new Error("Vault not connected"));C(this.vaultPort$(),r)},async requestVaultMessage(r,{timeout:o,instant:d=!1}={}){if(d)return this.vaultPort$()?be(this.vaultPort$(),r,{...o!=null&&{timeout:o}}):Promise.reject(new Error("Vault not connected"));let w=Date.now(),u=Promise.withResolvers();return u.promise.finally(()=>{this.msgQueue$(p=>(p.running=p.running.filter($=>$.p!==u),{...p}))}),this.msgQueue$(p=>(p.waiting.push({msg:r,timeout:o,queuedAt:w,p:u}),{...p})),u.promise},cancelPreviousRequests(r){this.msgQueue$().running.forEach(o=>o.p.resolve({code:o.msg.code,payload:null,error:r||new Error("Canceled")}))}})),_=Ee(),{session_openWorkspaceKeys$:a}=e,i=U(()=>{let r=a()[0];return e[`session_workspaceByKey_${r}_userPk$`]()}),c=U(()=>i()!==e.session_defaultUserPk$()||a().length>1),g=me(r=>c()?!1:(_.open(),r.p.resolve({code:r.msg.code,payload:null,error:new Error("Not logged in")}),!0));M(({track:r})=>{let[o,d]=r(()=>[n(),t()]);if(!d)return;let w=Math.min(5-o.running.length,o.waiting.length),u=Date.now();for(let p=0;p<w;p++){let $=o.waiting.shift();if(o.running.push($),g($))return;let{msg:K,timeout:W,queuedAt:x,p:R}=o.running[o.running.length-w+p];be(d,K,{...W!=null&&{timeout:x+W-u}}).then(y=>{R.resolve(y)})}})}D("nappAssetsCachingProgressBar",function(){let t;try{({cachingProgress$:t}=Z("<napp-assets-caching-progress-bar>"))}catch(i){console.warn("No cachingProgress$ store found",i);return}let e=U(()=>Object.entries(t()).filter(([i])=>!i.startsWith("_")&&(i.startsWith("/")||i.includes(".")))),s=U(()=>e().length>0),n=U(()=>{let i=e();if(i.length===0)return{overallProgress:0,fileList:"",fileCount:0};let c=i.reduce((d,[w,u])=>d+u.progress,0),g=Math.round(c/i.length),r=i.map(([d])=>{let w=d.split("/").pop()||d;return w.length>20?w.slice(0,17)+"...":w}),o=r.length>3?r.slice(0,3).join(", ")+`... (+${r.length-3} more)`:r.join(", ");return{overallProgress:g,fileList:o,fileCount:i.length}}),_=U(()=>`
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: 1000;
    background: linear-gradient(90deg,
      oklch(0.62 0.22 297.62 / 0.9) 0%,
      oklch(0.62 0.22 297.1 / 0.9) ${n().overallProgress}%,
      rgba(0, 0, 0, 0.7) ${n().overallProgress}%,
      rgba(0, 0, 0, 0.7) 100%
    );
    height: 4px;
    transition: all 0.3s ease;
    opacity: ${s()?1:0};
    transform: translateY(${s()?"0":"-100%"});
  `),a=U(()=>`
    position: absolute;
    top: 6px;
    left: 8px;
    right: 8px;
    background: rgba(0, 0, 0, 0.8);
    color: white;
    font-size: 12px;
    padding: 4px 8px;
    border-radius: 4px;
    backdrop-filter: blur(4px);
    transition: all 0.3s ease;
    opacity: ${s()?1:0};
    transform: translateY(${s()?"0":"-100%"});
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  `);return this.h`
    <div style=${_()} />
    <div style=${a()}>
      Caching ${n().fileCount} asset${n().fileCount!==1?"s":""}
      (${n().overallProgress}%): ${n().fileList}
    </div>
  `});export{kt as a,Wt as b,pt as c,Ee as d,is as e,Ne as f};
