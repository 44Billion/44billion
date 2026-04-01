import{b as Te,c as ie,d as Me}from"./chunk-FZKW7XBH.js";import{c as Ke,d as Ie,e as le,f as xe,o as me,p as ce}from"./chunk-4GBGHVLO.js";import{a as H,e as V,f as Be,g as Se,j as ge,l as ae}from"./chunk-4YEM5IRY.js";import{a as q,b as F,f as X}from"./chunk-TBF35Z4Q.js";import{g as D,i as he,j as Ee,n as N,o as re,p as G,q as Ae,s as J,v as M}from"./chunk-EOHNSKYH.js";var _e="0123456789abcdefghijklmnopqrstuvwxyz",je=BigInt(_e.length),He=_e[0],qe=new Map([..._e].map((t,e)=>[t,BigInt(e)]));function ze(t,e=0){return Pe(H(t),e)}function Pe(t,e=0){return Qe(Je(t),e)}function $t(t,e=0){return ze(Be(t),e)}function Oe(t){return Ge(Ye(t))}function Ye(t){if(typeof t!="string")throw new Error("Input must be a string.");let e=0n;for(let s of t){let n=qe.get(s);if(n===void 0)throw new Error(`Invalid character in Base36 string: ${s}`);e=e*je+n}return e}function Qe(t,e){if(typeof t!="bigint")throw new Error("Input must be a BigInt.");if(t<0n)throw new Error("Can't be signed BigInt");return t.toString(36).padStart(e,He)}function Ge(t){if(typeof t!="bigint")throw new Error("Input must be a BigInt.");if(t<0n)throw new Error("Can't be signed BigInt");let e=t.toString(16);return e.length%2!==0&&(e=`0${e}`),e}function Je(t){if(typeof t!="string")throw new Error("Input must be a string.");return BigInt(`0x${t}`)}function Re(t){if(t instanceof Error)return t;let e=new Error(t.message);return e.name=t.name||"Error",e.stack=t.stack,Object.assign(e,t.context||{}),e}var Ue=!1,Xe=Ue?"http://":"https://",Ze=Ue?"localhost:10000":"44billion.net",Et=`${Xe}${Ze}`;var Z={};function et(){return Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2)}function tt(t,e,s=5e3){if(!t||!e)throw new Error("Missing request id or code");let{promise:n,resolve:f,reject:a}=Promise.withResolvers();Z[t]={resolve:f,reject:a};let i;return s!=null&&(s>0?i=setTimeout(()=>{Z[t]?.reject?.(`Timeout for ${e} reqId: ${t}`)},s):Z[t]?.reject?.(`Timeout for ${e} reqId: ${t}`)),n.finally(()=>{clearTimeout(i),delete Z[t]})}function st(t){let e=Z[t.data.reqId];if(!e){console.log(`Unhandled response for reqId ${t.data.reqId} (may have timed out)`,JSON.stringify(t.data));return}t.data.error?e.reject(Re(t.data.error)):e.resolve({payload:t.data.payload,isLast:t.data.isLast??!0,ports:t.ports})}var nt=((t,e=new WeakMap,s=new FinalizationRegistry(n=>n.abort()))=>n=>{let f=n instanceof MessagePort;if(t=f?n:globalThis,e.has(t))return;let a=new AbortController;e.set(t,a),t.addEventListener("message",async i=>{if(i.data.code==="REPLY")return st(i)},{signal:a.signal}),f&&t.start(),s.register(t,a)})();async function we(t,e,s,n){if(!e.code&&!("payload"in e))throw new Error("Missing args");(!s||typeof s!="object")&&(s={targetOrigin:s,transfer:n}),nt(t);let f=et(),a=tt(f,e.code,s.timeout);return t.postMessage({...e,reqId:f},s),a.then(({payload:i,ports:c})=>({code:e.code,payload:i,ports:c})).catch(i=>({code:e.code,payload:null,error:i}))}function I(t,e,s,n){if(!("payload"in e)&&!("error"in e))throw new Error("Missing args");if((!s||typeof s!="object")&&(s={targetOrigin:s,transfer:n}),s.targetOrigin??=t.origin,!s.to&&!t.source)throw new Error("Set port to options.to");s.to??=t.source,s.to.postMessage({...e,reqId:t.data.reqId,code:"REPLY"},s)}function W(t,e,s,n){if(!e.code||!("payload"in e)&&!("error"in e))throw new Error("Missing args");(!s||typeof s!="object")&&(s={targetOrigin:s,transfer:n}),t.postMessage(e,s)}async function ot(t,e,s){try{let n=s.map(r=>me(r)),f=new Blob(n,{type:e.contentType}),a=new FileReader,c=await new Promise((r,o)=>{a.onload=()=>r(a.result),a.onerror=o,a.readAsDataURL(f)}),_={fx:e.rootHash,url:c};return q(localStorage,`session_appById_${t}_icon`,_),_}catch(n){console.log("Failed to update icon storage:",n)}}async function Ct(t,e,s,n,f,a,i,c,_,r,o,{signal:y,isSingleNapp:w=!1}={}){let h=Oe(t),u=V(h)===JSON.parse(localStorage.getItem("session_defaultUserPk")),$=new URL(JSON.parse(localStorage.getItem("config_vaultUrl")));document.querySelector(`iframe[src="${$.href.replace(/\/$/,"")}"]`)||console.warn("Vault iframe not found");let R=ge(e),E=await ce.create(e,R);w&&E.updateSiteManifestMetadata({lastOpenedAsSingleNappAt:Date.now()});let K=null,g=null;y?.addEventListener("abort",()=>{K&&(K.close(),K=null),g&&(g.close(),g=null)},{once:!0});let S,P=location.origin.replace("//",`//${s}.`);window.addEventListener("message",d=>{d.data.code!=="TRUSTED_IFRAME_READY"||d.source!==f.contentWindow||d.origin!==P||(S?.abort(),S=new AbortController,K&&K.close(),K=d.ports[0],ve(K,AbortSignal.any([y,S.signal])),te(s,n))},{signal:y});let T=!1;function te(d,C=""){if(T)return;T=!0;let m;window.addEventListener("message",p=>{p.data.code!=="APP_IFRAME_READY"||p.source!==a.contentWindow||p.origin!==P||(m?.abort(),m=new AbortController,g&&g.close(),g=p.ports[0],De(g,AbortSignal.any([y,m.signal])))},{signal:y});let l=window.location.host;i(`//${d}.${l}${C}`)}function ve(d,C){d.addEventListener("message",async m=>{switch(m.data.code){case"STREAM_APP_FILE":{let l=(p,k=new Error("FILE_NOT_CACHED"))=>(p&&console.log(p),I(m,{error:k,isLast:!0},{to:d}));try{let p=await E.getFileCacheStatus(m.data.payload.pathname,null,{withMeta:!0});if(!p.isCached)if(p.isHtml)l(null,new Error("HTML_FILE_NOT_CACHED"));else{let{fileRootHash:A,total:v}=p,b=0,B=!1,O=!1,z=!1,pe=async()=>{if(!(B||O||z)){z=!0;try{for(;!B&&!O;){let L=await Ie(e,A,{fromPos:b,toPos:b});if(L.length===0)break;let Y=L[0];if(v===null){let ne=Y.evt.tags.find(oe=>oe[0]==="c"&&oe[1].startsWith(`${A}:`)),j=parseInt(ne?.[2]);!Number.isNaN(j)&&j>0&&(v=j)}let Q=v!=null&&b===v-1;I(m,{payload:{content:Y.evt.content,...b===0&&{contentType:p.contentType}},isLast:Q},{to:d}),b++,Q&&(O=!0)}}catch(L){B=!0,l(L)}finally{z=!1}}},Fe=async({progress:L,chunkIndex:Y,total:Q,error:ne})=>{if(B||O)return;if(ne){B=!0;let fe=c(),{[m.data.payload.pathname]:Ve,...ye}=fe;return c(ye),l(ne)}Q&&v===null&&(v=Q);let j=m.data.payload.pathname,oe=c();c({...oe,[j]:{progress:L,totalByteSizeEstimate:v?(v-1)*51e3:0}}),L>=100&&setTimeout(()=>{let fe=c(),{[j]:Ve,...ye}=fe;c(ye)},1e3),typeof Y=="number"?Y===b&&await pe():await pe()};try{if(await pe(),!O&&!B)return E.cacheFile(m.data.payload.pathname,p.pathTag,Fe)}catch(L){return l(L)}}let k=0;for await(let A of le(e,E.getFileRootHash(m.data.payload.pathname)))I(m,{payload:{content:A.evt.content,...k===0&&{contentType:p.contentType}},isLast:++k===p.total},{to:d})}catch(p){return l(p,p)}break}}},{signal:C}),d.start(),W(d,{code:"BROWSER_READY",payload:null})}let U=new Map,se=new Map;async function de(d,C,{timeoutMs:m=1750}={}){if(U.has(d))return U.get(d);se.has(d)||se.set(d,{icon:!1,name:!1,promise:null});let l=se.get(d);if(l.promise)return l.promise;C??=ge(d);let p=await ce.create(d,C),k={id:d,napp:Te(C)},A=[];!("icon"in k)&&!l.icon&&(l.icon=!0,A.push(p.getIcon().then(b=>b&&(k.icon=b)).finally(()=>{l.icon=!1}))),!("name"in k)&&!l.name&&(l.name=!0,A.push(p.getName().then(b=>b&&(k.name=b)).finally(()=>{l.name=!1})));let v=(async()=>{if(A.length>0){let b=Promise.all(A).then(()=>U.set(d,k));await Promise.race([b,new Promise(B=>setTimeout(B,m))])}return U.set(d,k),se.delete(d),k})();return l.promise=v,v}function De(d,C){d.addEventListener("message",async m=>{switch(m.data.code){case"OPEN_APP":{let l;try{let{href:p}=m.data.payload,A=new URL(p,self.location.origin).pathname,v=/^\/(\+{1,3}[a-zA-Z0-9]{48,})/,b=A.match(v);if(!b){console.error("Invalid app URL format:",p);break}let B=b[1],O=ie(B);l=ae(O);let z=await de(l,O,{timeoutMs:0});await r({app:await de(e,R),name:"openApp",eKind:null,meta:{targetApp:z}}),o(p)}catch(p){let k=!1;for(let A of JSON.parse(localStorage.getItem("session_workspaceKeys"))??[])if(k=Array.isArray(JSON.parse(localStorage.getItem(`session_workspaceByKey_${A}_appById_${l}_appKeys`))),k)break;k||(q(localStorage,`session_appById_${l}_icon`,void 0),q(localStorage,`session_appById_${l}_name`,void 0),q(localStorage,`session_appById_${l}_description`,void 0),q(localStorage,`session_appById_${l}_relayHints`,void 0),await(await ce.create(l)).clearAppFiles()),console.error("Error in OPEN_APP handler:",p)}break}case"NIP07":{if(["peek_public_key","get_public_key"].includes(m.data.payload.method)&&m.data.payload.ns[0]===""&&m.data.payload.ns.length===1){I(m,{payload:h},{to:d});break}let{ns:l,method:p,params:k=[]}=m.data.payload,A=await de(e,R,{timeoutMs:0}),v;try{v=await lt(_,h,l,p,k,{isDefaultUser:u,requestPermission:r,app:A})}catch(b){v={error:b}}I(m,v,{to:d});break}case"WINDOW_NAPP":{rt(m);break}case"STREAM_APP_ICON":{try{let l=E.getFaviconMetadata();if(!l){I(m,{error:new Error("No favicon"),isLast:!0},{to:d});break}let p=await E.getFileCacheStatus(null,l.tag,{withMeta:!0});if(p.isCached||(await E.cacheFile(null,l.tag),p=await E.getFileCacheStatus(null,l.tag,{withMeta:!0})),E.service==="blossom"){let B=xe.create();for await(let O of le(e,l.rootHash))B.update(me(O.evt.content));if(H(B.digest())!==l.rootHash){l.rootHash&&await Ke(e,l.rootHash),I(m,{error:new Error("Icon hash mismatch"),isLast:!0},{to:d});break}}let A=JSON.parse(localStorage.getItem(`session_appById_${e}_icon`))?.fx!==l.rootHash,v=[],b=0;for await(let B of le(e,l.rootHash))A&&v.push(B.evt.content),I(m,{payload:{content:B.evt.content,...b===0&&{mimeType:l.mimeType||p.mimeType,contentType:l.contentType||p.contentType}},isLast:++b===p.total},{to:d});if(v.length>0){let{url:B}=await ot(e,l,v);if(U.has(e)){let O=U.get(e);O.icon={fx:l.rootHash,url:B}}}}catch(l){console.log(l.stack),I(m,{error:l,isLast:!0},{to:d})}break}case"CACHE_APP_FILE":{try{let l=({progress:p,error:k})=>{if(k)I(m,{error:k,isLast:!0},{to:d});else{let A=p>=100;I(m,{payload:p,isLast:A},{to:d})}};E.cacheFile(m.data.payload.pathname,null,l)}catch(l){console.log(m.data.payload.pathname,"error:",l.stack),I(m,{error:l,isLast:!0},{to:d})}break}}},{signal:C}),d.start(),W(d,{code:"BROWSER_READY",payload:null})}}function rt(t){return I(t,{error:new Error("Not implemented yet")})}var at={getPublicKey:"readProfile",signEvent:"signEvent",nip04Encrypt:"encrypt",nip04Decrypt:"decrypt",nip44Encrypt:"encrypt",nip44Decrypt:"decrypt"};function it(t){return at[t]||(()=>{throw new Error(`Unknown method ${t}`)})()}async function lt(t,e,s,n,f,{isDefaultUser:a,requestPermission:i,app:c}={}){if(a)throw new Error("Please login");if(i){let y=n.includes("_")?n.replace(/_([a-z0-9])/g,(h,u)=>u.toUpperCase()):n,w=(()=>{switch(y){case"signEvent":return f?.[0]?.kind;default:return null}})();await i({app:c,name:it(y),eKind:w,meta:{params:f}})}let{napp:_,...r}=c,o={code:"NIP07",payload:{app:{...r,id:_},pubkey:e,ns:s,method:n,params:f}};return t(o,{timeout:12e4})}function $e(){return V(ct(),43)}function ct(){let t=crypto.getRandomValues(new Uint8Array(40)),s=2n**256n-0x14551231950b75fc4402da1732fc9bebfn;return(((i,c)=>{let _=i%c;return _>=0n?_:c+_})((i=>BigInt("0x"+(H(i)||"0")))(t),s-1n)+1n).toString(16).padStart(64,"0")}var Le=["+32Wp7Qdz5XIbjlzHht7GdEP8IDxk6CC90ee8lRxYjx0stjsVD8yzTguF","+3swFhu23QNl8er5yOtc8bf9ueHCdwF8CzoDUiSSwwKIWoS8Ki5TwMyeA3Js1"].map(ie).map(ae);function ut(){let t=F(localStorage),e=F(sessionStorage);return Ae("hardcoded_newAppIdsObj",{}),M(()=>{if(t.session_workspaceKeys$())return;let s=$e();t.session_defaultUserPk$(s),Ce({userPk:s,storage:t,tabStorage:e,isFirstTimeUser:!0})}),M(()=>{if(!t.session_workspaceKeys$())return;let s=t.session_workspaceKeys$()||[],n=t.session_defaultUserPk$();s.forEach(f=>{let a=t[`session_workspaceByKey_${f}_userPk$`]();a!=null&&a!==n&&!(t[`session_accountByUserPk_${a}_isReadOnly$`]()??!1)&&t[`session_accountByUserPk_${a}_isLocked$`](!0)})}),M(({track:s})=>{if(s(()=>t.session_workspaceKeys$().length>0))return;let n=$e();t.session_defaultUserPk$(n),Ce({userPk:n,storage:t,tabStorage:e,isFirstTimeUser:!0})}),t}function Ce({userPk:t,storage:e,tabStorage:s,isFirstTimeUser:n}){let f=Le.map((c,_)=>({id:c,key:Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2),visibility:"closed",isNew:!1})),a=Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2);e.config_isSingleWindow$()===void 0&&e.config_isSingleWindow$(!1);let i=[];s[`session_workspaceByKey_${a}_openAppKeys$`](i),e[`session_workspaceByKey_${a}_userPk$`](t),f.forEach(c=>{e[`session_workspaceByKey_${a}_appById_${c.id}_appKeys$`]([c.key]),e[`session_appByKey_${c.key}_id$`](c.id),s[`session_appByKey_${c.key}_visibility$`](c.visibility),e[`session_appByKey_${c.key}_route$`]("")}),e[`session_workspaceByKey_${a}_unpinnedCoreAppIdsObj$`]({}),e[`session_workspaceByKey_${a}_pinnedAppIds$`](f.map(({id:c})=>c)),e[`session_workspaceByKey_${a}_unpinnedAppIds$`]([]),e[`session_accountByUserPk_${t}_isReadOnly$`](!0),e[`session_accountByUserPk_${t}_isLocked$`](!1),e[`session_accountByUserPk_${t}_profile$`]({npub:Me(Se(t)),meta:{events:[]}}),e[`session_accountByUserPk_${t}_relays$`]({meta:{events:[]}}),e.session_accountUserPks$([t]),e.session_workspaceKeys$([a]),e.session_openWorkspaceKeys$([a])}async function ke(t,e,s){let n=e.session_workspaceKeys$()||[],f=e.session_openWorkspaceKeys$()||[],a=e.session_defaultUserPk$(),i=n.length===1&&n.every(o=>e[`session_workspaceByKey_${o}_userPk$`]()===a);if(t.length===0&&i)return;let c=e.session_accountUserPks$()||[],_=t.map(o=>V(o.pubkey)),r;if(t.forEach(o=>{let y=V(o.pubkey);e[`session_accountByUserPk_${y}_isReadOnly$`](r=o.isReadOnly??!1),e[`session_accountByUserPk_${y}_isLocked$`](r?!1:o.isLocked??!0),e[`session_accountByUserPk_${y}_profile$`](o.profile),e[`session_accountByUserPk_${y}_relays$`](o.relays)}),i&&_.length===1){let o=n[0],y=_[0],w=s[`session_workspaceByKey_${o}_openAppKeys$`]()||[],h=[];w.forEach(u=>{s[`session_appByKey_${u}_visibility$`]($=>($==="open"&&h.push(u),"closed"))}),s[`session_workspaceByKey_${o}_openAppKeys$`]([]),e[`session_workspaceByKey_${o}_userPk$`](y),await new Promise(u=>setTimeout(u,0)),h.forEach(u=>{s[`session_appByKey_${u}_visibility$`]("open")}),s[`session_workspaceByKey_${o}_openAppKeys$`](h),e.session_defaultUserPk$(void 0)}else{let o=_.filter(g=>!c.includes(g)),y=c.filter(g=>!_.includes(g));o.length>0&&a&&e.session_defaultUserPk$(void 0);let w=[];for(let g of y)w=w.concat(n.filter(S=>e[`session_workspaceByKey_${S}_userPk$`]()===g));let h=[];for(let g of o){let S=Le.map(T=>({id:T,key:Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2),visibility:"closed",isNew:!1})),P=Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2);h.push(P),s[`session_workspaceByKey_${P}_openAppKeys$`]([]),e[`session_workspaceByKey_${P}_userPk$`](g),S.forEach(T=>{e[`session_workspaceByKey_${P}_appById_${T.id}_appKeys$`]([T.key]),e[`session_appByKey_${T.key}_id$`](T.id),s[`session_appByKey_${T.key}_visibility$`](T.visibility),e[`session_appByKey_${T.key}_route$`]("")}),e[`session_workspaceByKey_${P}_unpinnedCoreAppIdsObj$`]({}),e[`session_workspaceByKey_${P}_pinnedAppIds$`](S.map(({id:T})=>T)),e[`session_workspaceByKey_${P}_unpinnedAppIds$`]([])}let u=new Set(w),$=n.filter(g=>!u.has(g)).concat(h),x=new Set($),R=f.filter(g=>x.has(g)),E=new Set(R),K=R.concat($.filter(g=>!E.has(g)));e.session_openWorkspaceKeys$(K),e.session_workspaceKeys$($);for(let g of w){let S=e[`session_workspaceByKey_${g}_pinnedAppIds$`]()||[],P=e[`session_workspaceByKey_${g}_unpinnedAppIds$`]()||[],T=[...new Set([...S,...P])];e[`session_workspaceByKey_${g}_unpinnedCoreAppIdsObj$`](void 0),e[`session_workspaceByKey_${g}_pinnedAppIds$`](void 0),e[`session_workspaceByKey_${g}_unpinnedAppIds$`](void 0),e[`session_workspaceByKey_${g}_userPk$`](void 0),s[`session_workspaceByKey_${g}_openAppKeys$`](void 0),T.forEach(te=>{(e[`session_workspaceByKey_${g}_appById_${te}_appKeys$`]()||[]).forEach(U=>{e[`session_appByKey_${U}_id$`](void 0),s[`session_appByKey_${U}_visibility$`](void 0),e[`session_appByKey_${U}_route$`](void 0)}),e[`session_workspaceByKey_${g}_appById_${te}_appKeys$`](void 0)})}}e.session_accountUserPks$(_),c.filter(o=>!_.includes(o)).forEach(o=>{e[`session_accountByUserPk_${o}_isReadOnly$`](void 0),e[`session_accountByUserPk_${o}_isLocked$`](void 0),e[`session_accountByUserPk_${o}_profile$`](void 0),e[`session_accountByUserPk_${o}_relays$`](void 0)})}var Xt=D("aModal",function(){let t=re({dialogRef$:null,render:this.props.render,shouldAlwaysDisplay$:this.props.shouldAlwaysDisplay$??this.props.shouldAlwaysDisplay??!1,isOpen$:this.props.isOpen$,close:this.props.close,afterClose:this.props.afterClose});return M(({track:e})=>{e(()=>t.isOpen$.get())?t.dialogRef$().showModal():t.dialogRef$().close()},{after:"rendering"}),this.h`
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

              @media ${X.breakpoints.desktop} {
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

              @media ${X.breakpoints.mobile} {
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

                @media ${X.breakpoints.desktop} {
                  border-radius: 17px;
                  min-width: 400px;
                  width: 800px;
                  max-width: 90vw;
                  max-width: 90dvw;
                  max-height: 90vh; /* leave 10 for browser collapsible header */
                  max-height: 90dvh;
                }

                @media ${X.breakpoints.mobile} {
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
  `},{useShadowDOM:!1});function be(t){return t?dt(t):J("<a-modal>")}function dt(t){return J("<a-modal>",t)}D("vaultModal",function(){let t=be(),e=re(()=>({...t,shouldAlwaysDisplay$:!0,render:he(function(){return this.h`<vault-messenger-wrapper />`})}));return this.h`<a-modal props=${e} />`});D("vault-messenger-wrapper",function(){let t=F(localStorage),{config_vaultUrl$:e}=t;M(()=>{e()===void 0&&e("https://44billion.github.io/44b-vault")});let s=Ee(!1);M(async({track:f,cleanup:a})=>{let i=f(()=>e());if(!i){s(!1);return}s(!1);let c=0,_,r=new AbortController;a(()=>{clearTimeout(_),r.abort()});let o=async()=>{try{if(await fetch(i,{mode:"no-cors",signal:r.signal}),r.signal.aborted)return;s(!0)}catch{if(r.signal.aborted)return;c++;let w=Math.min(3e4,500*2**c);console.warn(`Vault unreachable, retrying in ${w}ms`),_=setTimeout(o,w)}};o()},{after:"rendering"});let{vaultPort$:n}=Ne({shouldInit:!0});return We(n),!e()||!s()?this.h``:this.h`${this.h({key:e()})`<vault-messenger />`}`});function Ne({shouldInit:t=!1}={}){return t?G("vaultMessenger",()=>({isWorkarounEnabled$:!0,disableStartAtVaultHomeWorkaroundThisTime(){this.isWorkarounEnabled$(!1)},isFirstRun$:!0,vaultPort$:null,vaultIframeRef$:null,vaultIframeSrc$:"about:blank",isVaultMessengerReady$:!1,widgetHeight$:0})):G("vaultMessenger")}D("vault-messenger",function(){let{isFirstRun$:t,vaultPort$:e,vaultIframeRef$:s,vaultIframeSrc$:n,isVaultMessengerReady$:f,widgetHeight$:a,isWorkarounEnabled$:i}=Ne();M(({cleanup:u})=>u(()=>{e(null),n("about:blank")}));let c=F(localStorage),_=F(sessionStorage),{config_vaultUrl$:r}=c,{cancelPreviousRequests:o,postVaultMessage:y}=We(e),w=be(),{isOpen$:h}=w;return M(({track:u})=>{let $=u(()=>h());t()||$||e()&&y({code:"CLOSED_VAULT_VIEW",payload:null},{instant:!0})}),M(({track:u})=>{let $=i();i(!0);let x=u(()=>!h());t()||x||!$||e()&&y({code:"OPEN_VAULT_HOME",payload:null},{instant:!0})}),M(()=>{t(!1)}),M(async({track:u,cleanup:$})=>{u(()=>r());let x=new AbortController;$(()=>{x.abort()});let R=new URL(r()).origin,E,K=()=>{E&&E.abort()},g=S=>{E=S,S&&S.signal.addEventListener("abort",()=>{E===S&&(E=null)},{once:!0})};s().addEventListener("load",()=>{setTimeout(()=>{K();let S=yt({vaultIframe:s(),vaultPort$:e,abortSignal:x.signal});g(S)},100)},{signal:x.signal}),ft({vaultIframe:s(),vaultOrigin:R,vaultPort$:e,componentSignal:x.signal,widgetHeight$:a,storage:c,tabStorage:_,stopRenderHandshake:K,vaultModalStore:w}),f(!0)},{after:"rendering"}),M(async({track:u})=>{let[$,x]=u(()=>[f(),r()]);$&&(n(x),o(new Error("Canceled due to new vault URL selection")))}),this.h`
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
  `});var ee=null,ue=[],pt=50;function rs(t){if(!ee){ue.length<pt&&ue.push(t);return}W(ee,t)}function ft({vaultIframe:t,vaultOrigin:e,vaultPort$:s,componentSignal:n,widgetHeight$:f,storage:a,tabStorage:i,stopRenderHandshake:c,vaultModalStore:_}){let r=null;n?.addEventListener("abort",()=>{r&&(r.close(),r=null,ee=null,ue.length=0)},{once:!0});let o;window.addEventListener("message",h=>{h.data.code!=="VAULT_READY"||h.source!==t.contentWindow||h.origin!==e||!h.ports[0]||(h.data.payload.accounts?ke(h.data.payload.accounts,a,i):console.log("Missing account data on vault startup"),o?.abort(),o=new AbortController,r&&r.close(),r=h.ports[0],ee=r,y({vaultPort:r,signal:AbortSignal.any([n,o.signal])}),c?.(),w(r),ue.splice(0).forEach(u=>W(ee,u)),s(r))},{signal:n});function y({vaultPort:h,signal:u}){h.addEventListener("message",$=>{switch($.data.code){case"CHANGE_DIMENSIONS":{f($.data.payload.height);break}case"CLOSE_VAULT_VIEW":{_.close();break}case"SET_ACCOUNTS_STATE":{if(!$.data.payload.accounts){console.log("Missing account data on vault message");break}ke($.data.payload.accounts,a,i);break}}},{signal:u}),h.start()}function w(h){W(h,{code:"BROWSER_READY",payload:null})}}function yt({vaultIframe:t,vaultPort$:e,abortSignal:s}){if(s?.aborted)return null;let n=new AbortController,{signal:f}=n,a,i=()=>{n.signal.aborted||n.abort()};s&&s.addEventListener("abort",i,{once:!0}),f.addEventListener("abort",()=>{a&&clearTimeout(a)},{once:!0});let c=40,_=0,r=()=>{if(f.aborted)return;let o=t?.contentWindow;if(!o){i();return}if(W(o,{code:"RENDER",payload:null},{targetOrigin:"*"}),e()){i();return}if(_>=c){i();return}_+=1;let y=Math.min(500,50*_);a=setTimeout(r,y)};return r(),n}function We(t){return t!==void 0&&ht(t),G("useRequestVaultMessage")}function ht(t){let e=F(localStorage),{config_vaultUrl$:s}=e,{msgQueue$:n}=G("useRequestVaultMessage",()=>({vaultPort$:t,vaultOrigin$(){return new URL(s()).origin},msgQueue$:{waiting:[],running:[]},postVaultMessage(r){if(!this.vaultPort$())return Promise.reject(new Error("Vault not connected"));W(this.vaultPort$(),r)},async requestVaultMessage(r,{timeout:o,instant:y=!1}={}){if(y)return this.vaultPort$()?we(this.vaultPort$(),r,{...o!=null&&{timeout:o}}):Promise.reject(new Error("Vault not connected"));let w=Date.now(),h=Promise.withResolvers();return h.promise.finally(()=>{this.msgQueue$(u=>(u.running=u.running.filter($=>$.p!==h),{...u}))}),this.msgQueue$(u=>(u.waiting.push({msg:r,timeout:o,queuedAt:w,p:h}),{...u})),h.promise},cancelPreviousRequests(r){this.msgQueue$().running.forEach(o=>o.p.resolve({code:o.msg.code,payload:null,error:r||new Error("Canceled")}))}})),f=be(),{session_openWorkspaceKeys$:a}=e,i=N(()=>{let r=a()[0];return e[`session_workspaceByKey_${r}_userPk$`]()}),c=N(()=>i()!==e.session_defaultUserPk$()||a().length>1),_=he(r=>c()?!1:(f.open(),r.p.resolve({code:r.msg.code,payload:null,error:new Error("Not logged in")}),!0));M(({track:r})=>{let[o,y]=r(()=>[n(),t()]);if(!y)return;let w=Math.min(5-o.running.length,o.waiting.length),h=Date.now();for(let u=0;u<w;u++){let $=o.waiting.shift();if(o.running.push($),_($))return;let{msg:x,timeout:R,queuedAt:E,p:K}=o.running[o.running.length-w+u];we(y,x,{...R!=null&&{timeout:E+R-h}}).then(g=>{K.resolve(g)})}})}D("nappAssetsCachingProgressBar",function(){let t;try{({cachingProgress$:t}=J("<napp-assets-caching-progress-bar>"))}catch(i){console.warn("No cachingProgress$ store found",i);return}let e=N(()=>Object.entries(t()).filter(([i])=>!i.startsWith("_")&&(i.startsWith("/")||i.includes(".")))),s=N(()=>e().length>0),n=N(()=>{let i=e();if(i.length===0)return{overallProgress:0,fileList:"",fileCount:0};let c=i.reduce((y,[w,h])=>y+h.progress,0),_=Math.round(c/i.length),r=i.map(([y])=>{let w=y.split("/").pop()||y;return w.length>20?w.slice(0,17)+"...":w}),o=r.length>3?r.slice(0,3).join(", ")+`... (+${r.length-3} more)`:r.join(", ");return{overallProgress:_,fileList:o,fileCount:i.length}}),f=N(()=>`
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
  `),a=N(()=>`
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
    <div style=${f()} />
    <div style=${a()}>
      Caching ${n().fileCount} asset${n().fileCount!==1?"s":""}
      (${n().overallProgress}%): ${n().fileList}
    </div>
  `});export{$t as a,Ct as b,ut as c,be as d,rs as e,We as f};
