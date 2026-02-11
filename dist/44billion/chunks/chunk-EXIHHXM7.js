import{b as M,g as H,h as C,i as U,j as K,l as J}from"./chunk-MS6YC6MO.js";import{g as z,o as x}from"./chunk-NID4PPA7.js";import{a as D,b as S,e as k}from"./chunk-KN6GOQRR.js";import{h as y,k as A,m as O,n as j,o as b,p as v,v as R,w as P}from"./chunk-K2UKPH6Q.js";var T=class{static _pendingSearches=new Map;static getInstalledAppIds({_localStorage:e}={}){let s=e||localStorage,r=JSON.parse(s.getItem("session_workspaceKeys")||"[]"),t=new Set;return r.forEach(o=>{let a=JSON.parse(s.getItem(`session_workspaceByKey_${o}_pinnedAppIds`)||"[]"),c=JSON.parse(s.getItem(`session_workspaceByKey_${o}_unpinnedAppIds`)||"[]");a.forEach(p=>t.add(p)),c.forEach(p=>t.add(p))}),Array.from(t)}static searchForUpdates(e,{_AppFileDownloader:s=K,_getBundleFromDb:r=C,_saveBundleToDb:t=U,_setWebStorageItem:o=D,_localStorage:a}={}){let c=e;(!c||c.length===0)&&(c=this.getInstalledAppIds({_localStorage:a}));let p=JSON.stringify(c.slice().sort());if(this._pendingSearches.has(p))return this._pendingSearches.get(p);let i=(async()=>{try{if(c.length===0)return{};let f=await s.getBundleEvents(c),l={};for(let h of c){let m=await r(h),I=f[h];if(I){let d=I.event,w=!1;m?d.created_at>m.created_at&&(w=!0):w=!0,w&&(l[h]=I),m&&await t(m,{...m.meta,hasUpdate:w})}else m&&await t(m,{...m.meta,hasUpdate:!1})}let u=this.getInstalledAppIds({_localStorage:a}),g=0;for(let h of u)(await r(h))?.meta?.hasUpdate&&g++;return o(a||(typeof localStorage<"u"?localStorage:null),"session_unread_appUpdateCount",g),l}finally{this._pendingSearches.delete(p)}})();return this._pendingSearches.set(p,i),i}static isAppOpen(e,{_localStorage:s}={}){let r=s||(typeof localStorage<"u"?localStorage:null);if(!r)return!1;let t=JSON.parse(r.getItem("session_workspaceKeys")||"[]");for(let o of t){let a=JSON.parse(r.getItem(`session_workspaceByKey_${o}_openAppKeys`)||"[]");if(JSON.parse(r.getItem(`session_workspaceByKey_${o}_appById_${e}_appKeys`)||"[]").some(p=>a.includes(p)))return!0}return!1}static async scheduleCleanup(e=null,{_localStorage:s,_getBundleFromDb:r=C,_deleteStaleFileChunksFromDb:t=M,_navigator:o=typeof navigator<"u"?navigator:null,_setTimeout:a=setTimeout,ifAvailable:c=!1}={}){if(o?.locks)return o.locks.request("app-cleanup-job",{ifAvailable:c},async p=>{if(!p)return;let i=e||this.getInstalledAppIds({_localStorage:s}),f=[];for(let l of i)if(this.isAppOpen(l,{_localStorage:s}))f.push(l);else{let u=await r(l);if(u){let g=u.tags.filter(h=>h[0]==="file").map(h=>h[1]);await t(l,g)}}f.length>0&&a(()=>{this.scheduleCleanup(f,{_localStorage:s,_getBundleFromDb:r,_deleteStaleFileChunksFromDb:t,_navigator:o,_setTimeout:a})},5*60*1e3)})}static initCleanupJob({_setTimeout:e=setTimeout,...s}={}){e(()=>this.scheduleCleanup(null,{...s,ifAvailable:!0}),2*60*1e3)}static async scheduleUpdateCheck({_navigator:e=typeof navigator<"u"?navigator:null,_setTimeout:s=setTimeout,ifAvailable:r=!1,interval:t=15*60*1e3,...o}={}){if(!e?.locks)return;if((e.connection||e.mozConnection||e.webkitConnection)?.metered){s(()=>this.scheduleUpdateCheck({_navigator:e,_setTimeout:s,interval:t,...o}),t);return}return e.locks.request("app-update-check-job",{ifAvailable:r},async c=>{if(c){try{await this.searchForUpdates(null,o)}catch(p){console.error("Update check failed",p)}s(()=>{this.scheduleUpdateCheck({_navigator:e,_setTimeout:s,interval:t,...o})},t)}})}static initUpdateCheckJob({_setTimeout:e=setTimeout,...s}={}){e(()=>this.scheduleUpdateCheck({...s,ifAvailable:!0}),1*60*1e3)}static async*updateApp(e,{_AppFileDownloader:s=K,_deleteStaleFileChunksFromDb:r=M,_saveBundleToDb:t=U,_getBundleFromDb:o=C,_addressObjToAppId:a=x,_getUserRelays:c=H,_localStorage:p,writeRelays:i}={}){let f=e.tags.find(d=>d[0]==="d")?.[1],l=a({kind:e.kind,pubkey:e.pubkey,dTag:f});if(!i){let d=await c([e.pubkey]);i=Array.from(d[e.pubkey].write)}let u=e.tags.filter(d=>d[0]==="file").map(d=>({rootHash:d[1],filename:d[2]})),g=u.length;for(let d=0;d<g;d++){let w=u[d],F=new s(l,w.rootHash,i);try{for await(let $ of F.run()){if($.error){yield{appProgress:0,fileProgress:0,error:$.error};return}yield{appProgress:Math.floor((d*100+$.progress)/g),fileProgress:$.progress,currentFile:w.filename,error:null}}}catch($){yield{appProgress:0,fileProgress:0,error:$};return}}let h=u.map(d=>d.rootHash);this.isAppOpen(l,{_localStorage:p})?await this.scheduleCleanup([l],{_localStorage:p,_getBundleFromDb:o,_deleteStaleFileChunksFromDb:r}):await r(l,h);let I=(await o(l))?.meta?.lastOpenedAsSingleNappAt||0;await t(e,{hasUpdate:!1,lastOpenedAsSingleNappAt:I})}static async*updateApps(e,{_updateApp:s=this.updateApp,_addressObjToAppId:r=x,...t}={}){let o=e.length;for(let a=0;a<o;a++){let c=e[a],p=c.tags.find(l=>l[0]==="d")?.[1],i=r({kind:c.kind,pubkey:c.pubkey,dTag:p}),f=s(c,{_addressObjToAppId:r,...t});try{for await(let l of f){let u=Math.floor((a*100+l.appProgress)/o);yield{appId:i,...l,overallProgress:u}}}catch(l){yield{appId:i,appProgress:0,fileProgress:0,error:l,overallProgress:Math.floor(a*100/o)}}}}};y("f-to-signals",function(){let n=this.props.from$??O(this.props.from),e=b(()=>(Array.isArray(n.get())?n.get().flat():Object.keys(n.get())).sort().join(":"));return this.h`${this.h({key:e.get()})`<f-to-signals-wrapped key=${e.get()} props=${{...this.props,from$:n}} />`}`});y("f-to-signals-wrapped",function(){let{render:n,...e}=this.props;return n.call(this,j(e))});var _=(()=>{let n=new WeakMap,e=0;function s(t){return n.has(t)||n.set(t,`obj:${++e}`),n.get(t)}function r(t){if(t===null)return"null";switch(typeof t){case"undefined":return"undefined";case"string":return`string:${t}`;case"number":return`number:${Number.isNaN(t)?"NaN":t}`;case"boolean":return`boolean:${t}`;case"bigint":return`bigint:${t}n`;case"symbol":return`symbol:${t.description??""}`;case"function":return s(t);case"object":return s(t);default:return`unknown:${String(t)}`}}return function(...o){try{let a=JSON.stringify(o);if(a!==void 0)return a}catch{}return o.map(r).join("|")}})();function Z(n,e=250,{getKey:s=_}={}){let r=new Map,t=new Map,o=new Map,a=Symbol("debounceDefaultKey");return function(...p){let i=s?s(...p):a;if(i==null)throw new Error("debounce: key cannot be undefined or null");let f=t.get(i);if(f)return f;let l=Date.now(),u=r.get(i);if(u!==void 0&&l-u<e)return o.get(i)??(()=>{throw new Error("debounce: no last promise found")})();r.set(i,l);let g=Promise.resolve().then(()=>n.apply(this,p)).catch(h=>{throw r.delete(i),h}).finally(()=>{t.delete(i)});return t.set(i,g),o.set(i,g),g}}async function q(n){await(await J.create(n)).getIcon()}var E=Z(q,1e3);y("appIcon",function(){let n=S(localStorage),e=b(()=>this.props.app$().id),s=b(()=>this.props.app$().index??"?"),r=b(()=>this.props.style$?.()??this.props.style??""),t=A(null),o=b(()=>!!t()),a=A(null);P(async({track:p})=>{let[,i]=p(()=>[e(),n[`session_appById_${e()}_icon$`]()]);if(!(i?.fx&&a()===i.fx)){if(a(i?.fx||null),i?.url){t(i.url);return}t(null)}});let c=A(!1);return P(async({track:p})=>{let i=p(()=>e());if(!(!i||o())){c(!0);try{await E(i)}catch(f){console.error("Failed to load app icon for appId:",i,f)}finally{requestIdleCallback(()=>c(!1),{timeout:150})}}}),c()?this.h`<div
      style=${`
        width: 100%;
        height: 100%;
        border-style: solid;
        border-width: 0;
        overflow: hidden;
        background-color: ${k.colors.bg2};
      `}
    >
      <style>${`
        @keyframes pulse {
          50% {
            opacity: .5;
          }
        }
        .animate-background {
          animation: pulse 2s cubic-bezier(.4,0,.6,1) infinite;
          background-color: ${k.colors.bg3};
          position: relative;
          height: 100%;
        }
      `}</style>
      <div class='animate-background' />
    </div>`:o()?this.h`
      <img
        src=${t()}
        alt="App Icon"
        style=${`
          width: 100%;
          height: 100%;
          object-fit: cover;
          ${r()}
        `}
      />
    `:this.h`
      <span style=${`
        font-weight: bold;
        font-size: 14px;
        display: flex;
        justify-content: center;
        align-items: center;
        width: 100%;
        height: 100%;
        ${r()}
      `}>${s()}</span>
    `});function N(){return Math.random().toString(36).slice(2)}var B=async function(n){try{return await W(L(n),{headers:X()})}catch(e){return console.log("Could not get avatar image",e.stack),V()}},L=function(n=N()){return`https://api.dicebear.com/9.x/avataaars/svg?${new URLSearchParams({radius:50,randomizeIds:"true",seed:n}).toString()}`},V=()=>{let n='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 280 280" fill="none" shape-rendering="auto"><metadata xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"><rdf:RDF><rdf:Description><dc:title>Avataaars</dc:title><dc:creator>Pablo Stanley</dc:creator><dc:source xsi:type="dcterms:URI">https://avataaars.com/</dc:source><dcterms:license xsi:type="dcterms:URI">https://avataaars.com/</dcterms:license><dc:rights>Remix of \u201EAvataaars\u201D (https://avataaars.com/) by \u201EPablo Stanley\u201D, licensed under \u201EFree for personal and commercial use\u201D (https://avataaars.com/)</dc:rights></rdf:Description></rdf:RDF></metadata><mask id="an70z9ld"><rect width="280" height="280" rx="140" ry="140" x="0" y="0" fill="#fff"/></mask><g mask="url(#an70z9ld)"><g transform="translate(8)"><path d="M132 36a56 56 0 0 0-56 56v6.17A12 12 0 0 0 66 110v14a12 12 0 0 0 10.3 11.88 56.04 56.04 0 0 0 31.7 44.73v18.4h-4a72 72 0 0 0-72 72v9h200v-9a72 72 0 0 0-72-72h-4v-18.39a56.04 56.04 0 0 0 31.7-44.73A12 12 0 0 0 198 124v-14a12 12 0 0 0-10-11.83V92a56 56 0 0 0-56-56Z" fill="#d08b5b"/><path d="M108 180.61v8a55.79 55.79 0 0 0 24 5.39c8.59 0 16.73-1.93 24-5.39v-8a55.79 55.79 0 0 1-24 5.39 55.79 55.79 0 0 1-24-5.39Z" fill="#000" fill-opacity=".1"/><g transform="translate(0 170)"><path d="M132.5 65.83c27.34 0 49.5-13.2 49.5-29.48 0-1.37-.16-2.7-.46-4.02A72.03 72.03 0 0 1 232 101.05V110H32v-8.95A72.03 72.03 0 0 1 83.53 32a18 18 0 0 0-.53 4.35c0 16.28 22.16 29.48 49.5 29.48Z" fill="#ffffff"/></g><g transform="translate(78 134)"><path d="M40 16c0 5.37 6.16 9 14 9s14-3.63 14-9c0-1.1-.95-2-2-2-1.3 0-1.87.9-2 2-1.24 2.94-4.32 4.72-10 5-5.68-.28-8.76-2.06-10-5-.13-1.1-.7-2-2-2-1.05 0-2 .9-2 2Z" fill="#000" fill-opacity=".6"/></g><g transform="translate(104 122)"><path fill-rule="evenodd" clip-rule="evenodd" d="M16 8c0 4.42 5.37 8 12 8s12-3.58 12-8" fill="#000" fill-opacity=".16"/></g><g transform="translate(76 90)"><path d="M27 16c-4.84 0-9 2.65-10.84 6.45-.54 1.1.39 1.85 1.28 1.12a15.13 15.13 0 0 1 9.8-3.22 6 6 0 1 0 10.7 2.8 2 2 0 0 0-.12-.74l-.15-.38a6 6 0 0 0-1.64-2.48C33.9 17.32 30.5 16 27 16ZM85 16c-4.84 0-9 2.65-10.84 6.45-.54 1.1.39 1.85 1.28 1.12a15.13 15.13 0 0 1 9.8-3.22 6 6 0 1 0 10.7 2.8 2 2 0 0 0-.12-.74l-.15-.38a6 6 0 0 0-1.64-2.48C91.9 17.32 88.5 16 85 16Z" fill="#000" fill-opacity=".6"/></g><g transform="translate(76 82)"><path d="M38.03 5.6c-1.48 8.38-14.1 14.17-23.24 10.42a2.04 2.04 0 0 0-2.64 1c-.43.97.04 2.1 1.05 2.5 11.45 4.7 26.84-2.37 28.76-13.3a1.92 1.92 0 0 0-1.64-2.2 2 2 0 0 0-2.3 1.57ZM73.97 5.6c1.48 8.38 14.1 14.17 23.24 10.42 1.02-.41 2.2.03 2.63 1 .43.97-.04 2.1-1.05 2.5-11.44 4.7-26.84-2.37-28.76-13.3a1.92 1.92 0 0 1 1.64-2.2 2 2 0 0 1 2.3 1.57Z" fill="#000" fill-opacity=".6"/></g><g transform="translate(-1)"><path fill-rule="evenodd" clip-rule="evenodd" d="M76 98c.35 1.49 1.67 1.22 2 0-.46-1.55 3.3-28.75 13-36 3.62-2.52 23-4.77 42.31-4.75 19.1 0 38.11 2.26 41.69 4.75 9.7 7.25 13.46 34.45 13 36 .33 1.22 1.65 1.49 2 0 .72-10.3 0-63.73-57-63-57 .73-57.72 52.7-57 63Z" fill="#2c1b18"/></g><g transform="translate(49 72)"/><g transform="translate(62 42)"/></g></g></svg>',e=n.match(/mask id="([^"]*)"/);return n.replaceAll(e,N())},W=async(n,e,s=5e3)=>{let r=new AbortController,t=fetch(n,e),o=new Promise(p=>setTimeout(p,s)),a=await Promise.race([t,o]);if(!a)throw r.abort(),new Error("API took too long to respond");let c=await a.text();if(!a.ok)throw new Error(c);return c},X=()=>{let n=new Headers;return n.append("Accept","image/svg+xml"),n};y("iconUserCircle",function(){let n=v({path$:["M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0","M12 10m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0","M6.168 18.849a4 4 0 0 1 3.832 -2.849h4a4 4 0 0 1 3.834 2.855"],viewBox$:"2 2 20 20"});return this.h`<a-svg
    props=${{...n,...this.props}}
  />`});y("aAvatar",function(){let n=S(localStorage),{props:e}=this,s=v({usePlaceholder$:e.usePlaceholder$??e.usePlaceholder??!1,pk$:e.pk$??e.pk,picture$(){let r=e.picture$?.()??e.picture??n[`session_accountByUserPk_${this.pk$()}_profile$`]()?.picture;if(!r)return null;let t=/^data:image\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*(?:;base64)?,/i.test(r),o=/^(https?:\/\/)[^\s?#]+\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)(?:[?#].*)?$/i.test(r),a=/^(?:\.{0,2}\/)?[^\s?#]+\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)(?:[?#].*)?$/i.test(r);return t||o||!a?r:null},svg$:R(()=>{let r=s.pk$();if(r)return B(z(r))})});return s.picture$()?this.h`<img
      src=${s.picture$()}
      alt='User avatar'
      style=${`
        width: 100%;
        height: 100%;
        object-fit: cover;
        border-radius: 50%;
        background-color: ${k.colors.bgAvatar};
      `}
    />`:!s.pk$()||!s.svg$()?s.usePlaceholder$()?this.h`<div
          style=${`
            width: 100%;
            height: 100%;
            border-style: solid;
            border-width: 0;
            overflow: hidden;
          `}
        >
          <style>${`
              @keyframes pulse {
                50% {
                  opacity: .5;
                }
              }
            .animate-background {
              animation: pulse 2s cubic-bezier(.4,0,.6,1) infinite;
              background-color: ${k.colors.bgAvatarLoading};
              position: relative;
              height: 100%;
            }
          `}</style>
          <div class='animate-background' />
        </div>`:this.h`<icon-user-circle props=${this.props} />`:this.h`<a-svg props=${{...this.props,svg:s.svg$()}} />`});export{T as a};
