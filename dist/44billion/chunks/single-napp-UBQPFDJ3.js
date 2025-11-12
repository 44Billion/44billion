import{a as g,d as S,j as I,k as A}from"./chunk-3S4EWIKO.js";import{B as b,E as w,H as y,L as k,h as u,k as a,o as m,t as i,w as $}from"./chunk-3BAMIFL4.js";u("singleNapp",function(){let c=g(localStorage),{session_openWorkspaceKeys$:s}=c,o=s()[0];if(!o)throw new Error("User n/a");return I(()=>({isOpen$:!1,open(){this.isOpen$(!0)},close(){this.isOpen$(!1)}})),i("napp",()=>{let r,l=[window.location].map(e=>(e.pathname.replace(/\/\+{1,3}[^/?#]+\/?/,p=>(r=p.replace(/^\/|\/$/g,""),"")).replace(/\/$/,"")+e.search+e.hash).replace(/^([^?#])/,"/$1"))[0],n=k(r),t=y(n);return{wsKey:o,appId:t,initialRoute:l}}),this.h`
    <vault-modal />
    <single-napp-launcher />
  `});u("singleNappLauncher",function(){let{wsKey:c,appId:s,initialRoute:o}=i("napp"),r=g(localStorage),{[`session_workspaceByKey_${c}_userPk$`]:l}=r,n=m(()=>b(l(),50)),t=m(()=>w(s,n())),e=a(),p=a("about:blank"),d=a(),f=a("about:blank"),{cachingProgress$:P}=i("<napp-assets-caching-progress-bar>",{cachingProgress$:{}}),{requestVaultMessage:K}=A();return $(async({cleanup:O})=>{let h=new AbortController;O(()=>h.abort()),await S(n(),s,t(),o,e(),d(),f,P,K,function(){throw new Error("Permission request not available in single napp mode yet")},function(){throw new Error("Open app not available in single napp mode yet")},{signal:h.signal,isSingleNapp:!0}),p(`//${t()}.${window.location.host}/~~napp`)},{after:"rendering"}),this.h`
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
        ref=${d}
        src=${f()}
      />
      <iframe
        class='tilde-tilde-napp-page'
        ref=${e}
        src=${p()}
      />
  `});
