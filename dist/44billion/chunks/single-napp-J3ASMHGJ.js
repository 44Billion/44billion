import{a as _,b as A,d as S,f as I}from"./chunk-T3NFDTWD.js";import{c as k}from"./chunk-FZKW7XBH.js";import"./chunk-TG3GHENF.js";import{l as y}from"./chunk-4YEM5IRY.js";import{b as $}from"./chunk-LLMC3MZB.js";import{g as d,j as t,n as g,s as l,v as w}from"./chunk-5XJKKVB7.js";d("singleNapp",function(){let u=$(localStorage),{session_openWorkspaceKeys$:s}=u,p=s()[0];if(!p)throw new Error("User n/a");return S(()=>({isOpen$:!1,open(){this.isOpen$(!0)},close(){this.isOpen$(!1)}})),l("napp",()=>{let e,n=[window.location].map(a=>(a.pathname.replace(/\/\+{1,3}[^/?#]+\/?/,i=>(e=i.replace(/^\/|\/$/g,""),"")).replace(/\/$/,"")+a.search+a.hash).replace(/^([^?#])/,"/$1"))[0],m=k(e),o=y(m);return{wsKey:p,appId:o,initialRoute:n}}),this.h`
    <vault-modal />
    <single-napp-launcher />
  `});d("singleNappLauncher",function(){let{wsKey:u,appId:s,initialRoute:p}=l("napp"),e=$(localStorage),{[`session_workspaceByKey_${u}_userPk$`]:n}=e,m=g(()=>_(n(),50)),o=g(()=>{let c=n();return c?e[`session_subdomainByUserAndApp_${c}_${s}$`]():null}),a=t(),i=t("about:blank"),f=t(),h=t("about:blank"),{cachingProgress$:P}=l("<napp-assets-caching-progress-bar>",{cachingProgress$:{}}),{requestVaultMessage:B}=I();return w(async({cleanup:c})=>{if(o()==null){let r=e.session_subdomainNextId$()??0;e.session_subdomainNextId$(r+1),e[`session_subdomainByUserAndApp_${n()}_${s}$`](String(r)),e[`session_subdomainToApp_${r}$`]({appId:s,userPk:n()})}let b=new AbortController;c(()=>b.abort()),await A(m(),s,o(),p,a(),f(),h,P,B,function(){throw new Error("Permission request not available in single napp mode yet")},function(){throw new Error("Open app not available in single napp mode yet")},{signal:b.signal,isSingleNapp:!0}),i(`//${o()}.${window.location.host}/~~napp`)},{after:"rendering"}),this.h`
      <style>
        iframe {
          &.tilde-tilde-napp-page { display: none; }

          &.napp-page {
            border: none;
            width: 100%;
            height: 100%;
            display: block; /* ensure it's not inline */
          }
        }
      </style>
      <napp-assets-caching-progress-bar />
      <iframe
      class='napp-page'
      allow='fullscreen; screen-wake-lock; ambient-light-sensor;
             autoplay; midi; encrypted-media;
             accelerometer; gyroscope; magnetometer; xr-spatial-tracking;
             clipboard-read; clipboard-write; web-share;
             camera; microphone;
             geolocation;
             bluetooth;
             payment'
        ref=${f}
        src=${h()}
      />
      <iframe
        class='tilde-tilde-napp-page'
        ref=${a}
        src=${i()}
      />
  `});
