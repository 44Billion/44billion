import { f, useGlobalStore, useClosestStore, useStore, useCallback } from '#f'
import '#f/components/f-to-signals.js'
import '#shared/modal.js'
import { hasPermission, createOrUpdatePermission } from '#services/idb/browser/queries/permission.js'
import { BROAD_EVENT_KIND, EVENT_ACCESS_PERMISSION, EVENT_ACCESS_PERSONAL_PERMISSION, ONE_TIME_DELETE_PERMISSION } from '#helpers/window-message/browser/event-permissions.js'
import { cssStrings, cssClasses, cssVars, jsVars } from '#assets/styles/theme.js'
import '#shared/app-icon.js'
import '#shared/icons/icon-x.js'
import useWebStorage from '#hooks/use-web-storage.js'
import { getT } from '#i18n/index.js'

const l = (en, fr, it, de, es, ptBR, ru, zhCN, zhTW, ja, ko) => ({
  en, fr, it, de, es, 'pt-BR': ptBR, ru, 'zh-CN': zhCN, 'zh-TW': zhTW, ja, ko
})

export const permissionDialogLocales = {
  profiles: l('profiles', 'profils', 'profili', 'Profile', 'perfiles', 'perfis', 'профили', '个人资料', '個人資料', 'プロフィール', '프로필'),
  'short text notes': l('short text notes', 'notes courtes', 'note brevi', 'Kurznotizen', 'notas cortas', 'notas curtas', 'короткие заметки', '短文本笔记', '短文字筆記', '短文ノート', '짧은 텍스트 노트'),
  'follow lists': l('follow lists', 'listes d’abonnements', 'liste dei seguiti', 'Kontaktlisten', 'listas de seguidos', 'listas de seguidos', 'списки подписок', '关注列表', '關注清單', 'フォローリスト', '팔로우 목록'),
  '(legacy) direct messages': l('(legacy) direct messages', 'messages directs (anciens)', 'messaggi diretti (legacy)', 'Direktnachrichten (veraltet)', 'mensajes directos (legado)', 'mensagens diretas (legado)', 'личные сообщения (устаревшие)', '（旧版）私信', '（舊版）私訊', '（旧式）ダイレクトメッセージ', '(레거시) 다이렉트 메시지'),
  'deletion requests': l('deletion requests', 'demandes de suppression', 'richieste di eliminazione', 'Löschanfragen', 'solicitudes de eliminación', 'solicitações de exclusão', 'запросы на удаление', '删除请求', '刪除要求', '削除リクエスト', '삭제 요청'),
  'short text renotes': l('short text renotes', 'republications courtes', 'repost brevi', 'Kurznotiz-Reposts', 'republicaciones cortas', 'republicações curtas', 'репосты коротких заметок', '短文本转发', '短文字轉發', '短文リノート', '짧은 텍스트 리노트'),
  reactions: l('reactions', 'réactions', 'reazioni', 'Reaktionen', 'reacciones', 'reações', 'реакции', '回应', '回應', 'リアクション', '반응'),
  'message seals': l('message seals', 'sceaux de messages', 'sigilli dei messaggi', 'Nachrichtenversiegelungen', 'sellos de mensajes', 'selos de mensagens', 'печати сообщений', '消息密封', '訊息密封', 'メッセージシール', '메시지 봉인'),
  '(public) chat messages': l('(public) chat messages', 'messages de chat (publics)', 'messaggi chat (pubblici)', 'öffentliche Chatnachrichten', 'mensajes de chat (públicos)', 'mensagens de chat (públicas)', 'публичные сообщения чата', '（公开）聊天消息', '（公開）聊天訊息', '（公開）チャットメッセージ', '(공개) 채팅 메시지'),
  '(public) file decryption keys': l('(public) file decryption keys', 'clés publiques de déchiffrement de fichiers', 'chiavi pubbliche di decifratura file', 'öffentliche Datei-Entschlüsselungsschlüssel', 'claves públicas de descifrado de archivos', 'chaves públicas de descriptografia de arquivos', 'публичные ключи расшифровки файлов', '（公开）文件解密密钥', '（公開）檔案解密金鑰', '（公開）ファイル復号鍵', '(공개) 파일 복호화 키'),
  renotes: l('renotes', 'republications', 'repost', 'Reposts', 'republicaciones', 'republicações', 'репосты', '转发', '轉發', 'リノート', '리노트'),
  pictures: l('pictures', 'images', 'immagini', 'Bilder', 'imágenes', 'imagens', 'изображения', '图片', '圖片', '画像', '사진'),
  videos: l('videos', 'vidéos', 'video', 'Videos', 'vídeos', 'vídeos', 'видео', '视频', '影片', '動画', '동영상'),
  'short vertical videos': l('short vertical videos', 'courtes vidéos verticales', 'brevi video verticali', 'kurze vertikale Videos', 'vídeos verticales cortos', 'vídeos verticais curtos', 'короткие вертикальные видео', '竖屏短视频', '直向短影片', '縦型ショート動画', '짧은 세로 동영상'),
  'delete-all requests': l('delete-all requests', 'demandes de suppression totale', 'richieste di eliminazione totale', 'Anfragen zum vollständigen Löschen', 'solicitudes de eliminar todo', 'solicitações para excluir tudo', 'запросы на удаление всего', '全部删除请求', '全部刪除要求', '全削除リクエスト', '전체 삭제 요청'),
  'poll responses': l('poll responses', 'réponses aux sondages', 'risposte ai sondaggi', 'Umfrageantworten', 'respuestas a encuestas', 'respostas a enquetes', 'ответы на опросы', '投票回应', '投票回應', '投票への回答', '투표 응답'),
  'recipient directions': l('recipient directions', 'indications de destinataires', 'indicazioni dei destinatari', 'Empfängeranweisungen', 'indicaciones de destinatarios', 'direcionamentos de destinatários', 'указания получателей', '收件人指示', '收件者指示', '受信者の指定', '수신자 지시'),
  polls: l('polls', 'sondages', 'sondaggi', 'Umfragen', 'encuestas', 'enquetes', 'опросы', '投票', '投票', '投票', '투표'),
  comments: l('comments', 'commentaires', 'commenti', 'Kommentare', 'comentarios', 'comentários', 'комментарии', '评论', '留言', 'コメント', '댓글'),
  'short voice notes': l('short voice notes', 'notes vocales courtes', 'brevi note vocali', 'kurze Sprachnotizen', 'notas de voz cortas', 'notas de voz curtas', 'короткие голосовые заметки', '短语音笔记', '短語音筆記', '短い音声ノート', '짧은 음성 노트'),
  'short voice comments': l('short voice comments', 'commentaires vocaux courts', 'brevi commenti vocali', 'kurze Sprachkommentare', 'comentarios de voz cortos', 'comentários de voz curtos', 'короткие голосовые комментарии', '短语音评论', '短語音留言', '短い音声コメント', '짧은 음성 댓글'),
  'misconduct reports': l('misconduct reports', 'signalements d’abus', 'segnalazioni di abusi', 'Missbrauchsmeldungen', 'denuncias de conducta indebida', 'denúncias de má conduta', 'жалобы на нарушения', '不当行为举报', '不當行為檢舉', '不正行為の報告', '위법 행위 신고'),
  'private-channel broadcasts': l('private-channel broadcasts', 'diffusions de canal privé', 'trasmissioni di canali privati', 'Private-Channel-Broadcasts', 'difusiones de canal privado', 'transmissões de canal privado', 'трансляции приватных каналов', '私密频道广播', '私人頻道廣播', 'プライベートチャンネル配信', '비공개 채널 브로드캐스트'),
  'nutzap redemption logs': l('nutzap redemption logs', 'journaux d’encaissement nutzap', 'registri di riscossione nutzap', 'Nutzap-Einlösungsprotokolle', 'registros de canje de nutzaps', 'registros de resgate de nutzaps', 'журналы погашения nutzap', 'nutzap 兑换日志', 'nutzap 兌換紀錄', 'nutzap 引換ログ', 'nutzap 상환 로그'),
  nutzaps: l('nutzaps', 'nutzaps', 'nutzap', 'Nutzaps', 'nutzaps', 'nutzaps', 'nutzap', 'nutzap', 'nutzap', 'nutzap', 'nutzap'),
  'bitcoin pre-payment data': l('bitcoin pre-payment data', 'données de prépaiement bitcoin', 'dati di prepagamento bitcoin', 'Bitcoin-Vorauszahlungsdaten', 'datos de prepago de bitcoin', 'dados de pré-pagamento bitcoin', 'данные предоплаты bitcoin', '比特币预付款数据', '比特幣預付款資料', 'ビットコイン前払いデータ', '비트코인 선결제 데이터'),
  'bitcoin receipts': l('bitcoin receipts', 'reçus bitcoin', 'ricevute bitcoin', 'Bitcoin-Belege', 'recibos de bitcoin', 'recibos bitcoin', 'квитанции bitcoin', '比特币收据', '比特幣收據', 'ビットコイン領収書', '비트코인 영수증'),
  'home server configurations': l('home server configurations', 'configurations de serveurs personnels', 'configurazioni dei server personali', 'Home-Server-Konfigurationen', 'configuraciones de servidores personales', 'configurações de servidores pessoais', 'настройки домашних серверов', '家庭服务器配置', '家用伺服器設定', 'ホームサーバー設定', '홈 서버 구성'),
  'nutzap receiving addresses': l('nutzap receiving addresses', 'adresses de réception nutzap', 'indirizzi di ricezione nutzap', 'Nutzap-Empfangsadressen', 'direcciones de recepción de nutzaps', 'endereços de recebimento de nutzaps', 'адреса получения nutzap', 'nutzap 接收地址', 'nutzap 接收位址', 'nutzap 受取アドレス', 'nutzap 수신 주소'),
  'private-channel router rows': l('private-channel router rows', 'lignes de routage de canal privé', 'righe router di canali privati', 'Private-Channel-Routerzeilen', 'filas de enrutamiento de canal privado', 'linhas de roteamento de canal privado', 'строки маршрутизации приватных каналов', '私密频道路由记录', '私人頻道路由紀錄', 'プライベートチャンネルのルーター行', '비공개 채널 라우터 행'),
  'API authentication requests': l('API authentication requests', 'demandes d’authentification API', 'richieste di autenticazione API', 'API-Authentifizierungsanfragen', 'solicitudes de autenticación de API', 'solicitações de autenticação de API', 'запросы аутентификации API', 'API 身份验证请求', 'API 驗證要求', 'API 認証リクエスト', 'API 인증 요청'),
  'profile badges': l('profile badges', 'badges de profil', 'badge del profilo', 'Profilabzeichen', 'insignias de perfil', 'selos de perfil', 'значки профиля', '个人资料徽章', '個人資料徽章', 'プロフィールバッジ', '프로필 배지'),
  'profile badge definitions': l('profile badge definitions', 'définitions de badges de profil', 'definizioni dei badge del profilo', 'Profilabzeichen-Definitionen', 'definiciones de insignias de perfil', 'definições de selos de perfil', 'описания значков профиля', '个人资料徽章定义', '個人資料徽章定義', 'プロフィールバッジ定義', '프로필 배지 정의'),
  'long text notes': l('long text notes', 'notes longues', 'note lunghe', 'Langtextnotizen', 'notas largas', 'notas longas', 'длинные заметки', '长文本笔记', '長文字筆記', '長文ノート', '긴 텍스트 노트'),
  livestreams: l('livestreams', 'diffusions en direct', 'dirette', 'Livestreams', 'transmisiones en directo', 'transmissões ao vivo', 'прямые трансляции', '直播', '直播', 'ライブ配信', '라이브 스트림'),
  'classified listings': l('classified listings', 'petites annonces', 'annunci', 'Kleinanzeigen', 'anuncios clasificados', 'anúncios classificados', 'объявления', '分类信息', '分類廣告', 'クラシファイド広告', '분류 광고'),
  '(draft) classified listings': l('(draft) classified listings', 'brouillons de petites annonces', 'bozze di annunci', 'Kleinanzeigenentwürfe', 'borradores de anuncios clasificados', 'rascunhos de anúncios classificados', 'черновики объявлений', '（草稿）分类信息', '（草稿）分類廣告', '（下書き）クラシファイド広告', '(초안) 분류 광고'),
  'date events': l('date events', 'événements datés', 'eventi con data', 'Datumstermine', 'eventos con fecha', 'eventos com data', 'события с датой', '日期事件', '日期事件', '日付イベント', '날짜 이벤트'),
  'time events': l('time events', 'événements horaires', 'eventi con orario', 'Zeitereignisse', 'eventos con hora', 'eventos com horário', 'события со временем', '时间事件', '時間事件', '時刻イベント', '시간 이벤트'),
  calendars: l('calendars', 'calendriers', 'calendari', 'Kalender', 'calendarios', 'calendários', 'календари', '日历', '行事曆', 'カレンダー', '캘린더'),
  'event RSVPs': l('event RSVPs', 'réponses aux invitations', 'risposte agli inviti', 'Veranstaltungszusagen', 'respuestas a invitaciones', 'respostas a convites', 'ответы на приглашения', '活动回复', '活動回覆', 'イベント出欠回答', '이벤트 참석 응답'),
  files: l('files', 'fichiers', 'file', 'Dateien', 'archivos', 'arquivos', 'файлы', '文件', '檔案', 'ファイル', '파일'),
  'site manifests': l('site manifests', 'manifestes de sites', 'manifesti dei siti', 'Website-Manifeste', 'manifiestos de sitios', 'manifestos de sites', 'манифесты сайтов', '站点清单', '網站資訊清單', 'サイトマニフェスト', '사이트 매니페스트'),
  '(next) site manifests': l('(next) site manifests', 'prochains manifestes de sites', 'prossimi manifesti dei siti', 'nächste Website-Manifeste', 'próximos manifiestos de sitios', 'próximos manifestos de sites', 'следующие манифесты сайтов', '（下一版）站点清单', '（下一版）網站資訊清單', '（次版）サイトマニフェスト', '(다음) 사이트 매니페스트'),
  '(draft) site manifests': l('(draft) site manifests', 'brouillons de manifestes de sites', 'bozze di manifesti dei siti', 'Website-Manifestentwürfe', 'borradores de manifiestos de sitios', 'rascunhos de manifestos de sites', 'черновики манифестов сайтов', '（草稿）站点清单', '（草稿）網站資訊清單', '（下書き）サイトマニフェスト', '(초안) 사이트 매니페스트'),
  'app data': l('app data', 'données d’application', 'dati dell’app', 'App-Daten', 'datos de la aplicación', 'dados do app', 'данные приложения', '应用数据', '應用程式資料', 'アプリデータ', '앱 데이터'),
  'app data type {{kind}}': l('app data type {{kind}}', 'données d’application de type {{kind}}', 'dati dell’app di tipo {{kind}}', 'App-Daten des Typs {{kind}}', 'datos de aplicación de tipo {{kind}}', 'dados do app do tipo {{kind}}', 'данные приложения типа {{kind}}', '{{kind}} 类型的应用数据', '{{kind}} 類型的應用程式資料', '種類 {{kind}} のアプリデータ', '{{kind}} 유형의 앱 데이터'),
  'Can I read your profile?': l('Can I read your profile?', 'Puis-je lire votre profil ?', 'Posso leggere il tuo profilo?', 'Darf ich Ihr Profil lesen?', '¿Puedo leer tu perfil?', 'Posso ler seu perfil?', 'Можно прочитать ваш профиль?', '可以读取你的个人资料吗？', '可以讀取你的個人資料嗎？', 'あなたのプロフィールを読み取ってもよいですか？', '프로필을 읽어도 될까요?'),
  'Can I access all app data?': l('Can I access all app data?', 'Puis-je accéder à toutes les données des applications ?', 'Posso accedere a tutti i dati delle app?', 'Darf ich auf alle App-Daten zugreifen?', '¿Puedo acceder a todos los datos de las aplicaciones?', 'Posso acessar todos os dados dos apps?', 'Можно получить доступ ко всем данным приложений?', '可以访问所有应用数据吗？', '可以存取所有應用程式資料嗎？', 'すべてのアプリデータにアクセスしてもよいですか？', '모든 앱 데이터에 접근해도 될까요?'),
  'Can I access all personal data?': l('Can I access all personal data?', 'Puis-je accéder à toutes les données personnelles ?', 'Posso accedere a tutti i dati personali?', 'Darf ich auf alle persönlichen Daten zugreifen?', '¿Puedo acceder a todos los datos personales?', 'Posso acessar todos os dados pessoais?', 'Можно получить доступ ко всем личным данным?', '可以访问所有个人数据吗？', '可以存取所有個人資料嗎？', 'すべての個人データにアクセスしてもよいですか？', '모든 개인 데이터에 접근해도 될까요?'),
  'Can I access {{dataType}}?': l('Can I access {{dataType}}?', 'Puis-je accéder aux données suivantes : {{dataType}} ?', 'Posso accedere a questi dati: {{dataType}}?', 'Darf ich auf Daten des Typs „{{dataType}}“ zugreifen?', '¿Puedo acceder a estos datos: {{dataType}}?', 'Posso acessar estes dados: {{dataType}}?', 'Можно получить доступ к данным типа «{{dataType}}»?', '可以访问此类数据吗：{{dataType}}？', '可以存取這類資料嗎：{{dataType}}？', '次のデータにアクセスしてもよいですか：{{dataType}}？', '다음 데이터에 접근해도 될까요: {{dataType}}?'),
  'Can I access personal copies of {{dataType}}?': l('Can I access personal copies of {{dataType}}?', 'Puis-je accéder aux copies personnelles des données suivantes : {{dataType}} ?', 'Posso accedere alle copie personali di questi dati: {{dataType}}?', 'Darf ich auf persönliche Kopien von Daten des Typs „{{dataType}}“ zugreifen?', '¿Puedo acceder a copias personales de estos datos: {{dataType}}?', 'Posso acessar cópias pessoais destes dados: {{dataType}}?', 'Можно получить доступ к личным копиям данных типа «{{dataType}}»?', '可以访问此类数据的个人副本吗：{{dataType}}？', '可以存取這類資料的個人副本嗎：{{dataType}}？', '次のデータの個人用コピーにアクセスしてもよいですか：{{dataType}}？', '다음 데이터의 개인 사본에 접근해도 될까요: {{dataType}}?'),
  'Can I access content that needs login?': l('Can I access content that needs login?', 'Puis-je accéder au contenu nécessitant une connexion ?', 'Posso accedere ai contenuti che richiedono l’accesso?', 'Darf ich auf Inhalte zugreifen, die eine Anmeldung erfordern?', '¿Puedo acceder a contenido que requiere iniciar sesión?', 'Posso acessar conteúdo que exige login?', 'Можно получить доступ к содержимому, требующему входа?', '可以访问需要登录的内容吗？', '可以存取需要登入的內容嗎？', 'ログインが必要なコンテンツにアクセスしてもよいですか？', '로그인이 필요한 콘텐츠에 접근해도 될까요?'),
  'Can I delete {{count}} items?': {
    en: { one: 'Can I delete {{count}} item?', other: 'Can I delete {{count}} items?' },
    fr: { one: 'Puis-je supprimer {{count}} élément ?', other: 'Puis-je supprimer {{count}} éléments ?' },
    it: { one: 'Posso eliminare {{count}} elemento?', other: 'Posso eliminare {{count}} elementi?' },
    de: { one: 'Darf ich {{count}} Element löschen?', other: 'Darf ich {{count}} Elemente löschen?' },
    es: { one: '¿Puedo eliminar {{count}} elemento?', other: '¿Puedo eliminar {{count}} elementos?' },
    'pt-BR': { one: 'Posso excluir {{count}} item?', other: 'Posso excluir {{count}} itens?' },
    ru: { one: 'Можно удалить {{count}} элемент?', few: 'Можно удалить {{count}} элемента?', many: 'Можно удалить {{count}} элементов?', other: 'Можно удалить {{count}} элемента?' },
    'zh-CN': { other: '可以删除 {{count}} 个项目吗？' }, 'zh-TW': { other: '可以刪除 {{count}} 個項目嗎？' }, ja: { other: '{{count}} 件を削除してもよいですか？' }, ko: { other: '{{count}}개 항목을 삭제해도 될까요?' }
  },
  'Can I delete ALL your items from ALL servers?': l('Can I delete ALL your items from ALL servers?', 'Puis-je supprimer TOUS vos éléments de TOUS les serveurs ?', 'Posso eliminare TUTTI i tuoi elementi da TUTTI i server?', 'Darf ich ALLE Ihre Elemente von ALLEN Servern löschen?', '¿Puedo eliminar TODOS tus elementos de TODOS los servidores?', 'Posso excluir TODOS os seus itens de TODOS os servidores?', 'Можно удалить ВСЕ ваши элементы со ВСЕХ серверов?', '可以从所有服务器删除你的所有项目吗？', '可以從所有伺服器刪除你的所有項目嗎？', 'すべてのサーバーからあなたの全項目を削除してもよいですか？', '모든 서버에서 모든 항목을 삭제해도 될까요?'),
  'Can I delete ALL your items from {{count}} servers?': {
    en: { one: 'Can I delete ALL your items from {{count}} server?', other: 'Can I delete ALL your items from {{count}} servers?' },
    fr: { one: 'Puis-je supprimer TOUS vos éléments de {{count}} serveur ?', other: 'Puis-je supprimer TOUS vos éléments de {{count}} serveurs ?' },
    it: { one: 'Posso eliminare TUTTI i tuoi elementi da {{count}} server?', other: 'Posso eliminare TUTTI i tuoi elementi da {{count}} server?' },
    de: { one: 'Darf ich ALLE Ihre Elemente von {{count}} Server löschen?', other: 'Darf ich ALLE Ihre Elemente von {{count}} Servern löschen?' },
    es: { one: '¿Puedo eliminar TODOS tus elementos de {{count}} servidor?', other: '¿Puedo eliminar TODOS tus elementos de {{count}} servidores?' },
    'pt-BR': { one: 'Posso excluir TODOS os seus itens de {{count}} servidor?', other: 'Posso excluir TODOS os seus itens de {{count}} servidores?' },
    ru: { one: 'Можно удалить ВСЕ ваши элементы с {{count}} сервера?', few: 'Можно удалить ВСЕ ваши элементы с {{count}} серверов?', many: 'Можно удалить ВСЕ ваши элементы с {{count}} серверов?', other: 'Можно удалить ВСЕ ваши элементы с {{count}} сервера?' },
    'zh-CN': { other: '可以从 {{count}} 个服务器删除你的所有项目吗？' }, 'zh-TW': { other: '可以從 {{count}} 個伺服器刪除你的所有項目嗎？' }, ja: { other: '{{count}} 台のサーバーからあなたの全項目を削除してもよいですか？' }, ko: { other: '{{count}}개 서버에서 모든 항목을 삭제해도 될까요?' }
  },
  'Can I open the {{appName}} app?': l('Can I open the {{appName}} app?', 'Puis-je ouvrir l’application {{appName}} ?', 'Posso aprire l’app {{appName}}?', 'Darf ich die App {{appName}} öffnen?', '¿Puedo abrir la aplicación {{appName}}?', 'Posso abrir o app {{appName}}?', 'Можно открыть приложение {{appName}}?', '可以打开 {{appName}} 应用吗？', '可以開啟 {{appName}} 應用程式嗎？', '{{appName}} アプリを開いてもよいですか？', '{{appName}} 앱을 열어도 될까요?'),
  'Can I {{action}} {{dataType}}?': l('Can I {{action}} {{dataType}}?', 'Puis-je effectuer « {{action}} » sur {{dataType}} ?', 'Posso eseguire “{{action}}” su {{dataType}}?', 'Darf ich „{{action}}“ für {{dataType}} ausführen?', '¿Puedo ejecutar «{{action}}» sobre {{dataType}}?', 'Posso executar “{{action}}” em {{dataType}}?', 'Можно выполнить «{{action}}» для «{{dataType}}»?', '可以对 {{dataType}} 执行“{{action}}”吗？', '可以對 {{dataType}} 執行「{{action}}」嗎？', '{{dataType}} に「{{action}}」を実行してもよいですか？', '{{dataType}}에 “{{action}}” 작업을 수행해도 될까요?'),
  'Channel: {{scope}}': l('Channel: {{scope}}', 'Canal : {{scope}}', 'Canale: {{scope}}', 'Kanal: {{scope}}', 'Canal: {{scope}}', 'Canal: {{scope}}', 'Канал: {{scope}}', '频道：{{scope}}', '頻道：{{scope}}', 'チャンネル：{{scope}}', '채널: {{scope}}'),
  'Scope: {{scope}}': l('Scope: {{scope}}', 'Portée : {{scope}}', 'Ambito: {{scope}}', 'Bereich: {{scope}}', 'Ámbito: {{scope}}', 'Escopo: {{scope}}', 'Область: {{scope}}', '范围：{{scope}}', '範圍：{{scope}}', '範囲：{{scope}}', '범위: {{scope}}'),
  App: l('App', 'Application', 'App', 'App', 'Aplicación', 'App', 'Приложение', '应用', '應用程式', 'アプリ', '앱'),
  Allow: l('Allow', 'Autoriser', 'Consenti', 'Zulassen', 'Permitir', 'Permitir', 'Разрешить', '允许', '允許', '許可', '허용')
}

const t = getT(permissionDialogLocales)

const EVENT_KIND_TEXT = {
  0: 'profiles', 1: 'short text notes', 3: 'follow lists', 4: '(legacy) direct messages', 5: 'deletion requests', 6: 'short text renotes', 7: 'reactions', 13: 'message seals', 14: '(public) chat messages', 15: '(public) file decryption keys', 16: 'renotes', 20: 'pictures', 21: 'videos', 22: 'short vertical videos', 62: 'delete-all requests', 1018: 'poll responses', 1059: 'recipient directions', 1068: 'polls', 1111: 'comments', 1222: 'short voice notes', 1244: 'short voice comments', 1984: 'misconduct reports', 3560: 'private-channel broadcasts', 7376: 'nutzap redemption logs', 9321: 'nutzaps', 9734: 'bitcoin pre-payment data', 9735: 'bitcoin receipts', 10002: 'home server configurations', 10019: 'nutzap receiving addresses', 26300: 'private-channel router rows', 27235: 'API authentication requests', 30008: 'profile badges', 30009: 'profile badge definitions', 30023: 'long text notes', 30311: 'livestreams', 30402: 'classified listings', 30403: '(draft) classified listings', 31922: 'date events', 31923: 'time events', 31924: 'calendars', 31925: 'event RSVPs', 34601: 'files', 35128: 'site manifests', 35129: '(next) site manifests', 35130: '(draft) site manifests'
}

function getEventKindText (kind, translate) {
  const key = EVENT_KIND_TEXT[kind]
  if (key) return translate(key)
  return kind == null ? translate('app data') : translate('app data type {{kind}}', { kind })
}

function getScopeText (scope, eKind, translate) {
  if (!scope) return ''
  const normalized = String(scope).replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  const clipped = normalized.length > 48 ? `${normalized.slice(0, 32)}...${normalized.slice(-12)}` : normalized
  return eKind === 26300 && /^[0-9a-f]{64}$/i.test(normalized)
    ? translate('Channel: {{scope}}', { scope: `${normalized.slice(0, 8)}...${normalized.slice(-8)}` })
    : translate('Scope: {{scope}}', { scope: clipped })
}

export function formatPermissionText ({ name, eKind, meta, getCachedAppName = () => undefined, translate = t }) {
  let text
  if (eKind === 22242) {
    text = translate('Can I access content that needs login?')
  } else if (name === ONE_TIME_DELETE_PERMISSION && eKind === 5) {
    const event = meta?.params?.[0]
    if (!event) throw new Error('Missing event parameter for eKind 5 permission')
    const deleteCount = event.tags.filter(tag => ['e', 'a'].includes(tag[0])).length || 1
    text = translate('Can I delete {{count}} items?', { count: deleteCount })
  } else if (name === ONE_TIME_DELETE_PERMISSION && eKind === 62) {
    const event = meta?.params?.[0]
    if (!event) throw new Error('Missing event parameter for eKind 62 permission')
    const relayTags = event.tags.filter(tag => tag[0] === 'relay')
    const allRelays = relayTags.some(tag => tag[1] === 'ALL_RELAYS')
    const relayCount = relayTags.length || 1
    text = allRelays
      ? translate('Can I delete ALL your items from ALL servers?')
      : translate('Can I delete ALL your items from {{count}} servers?', { count: relayCount })
  } else if (name === 'openApp') {
    const { targetApp } = meta ?? {}
    if (!targetApp) throw new Error('Missing app parameter for openApp permission')
    const appName = targetApp.name || getCachedAppName(targetApp.id) || targetApp.alias || targetApp.napp
    if (appName == null) throw new Error('Missing app name for openApp permission')
    text = translate('Can I open the {{appName}} app?', { appName })
  } else if (name === 'readProfile') {
    text = translate('Can I read your profile?')
  } else if (name === EVENT_ACCESS_PERMISSION && eKind === BROAD_EVENT_KIND) {
    text = translate('Can I access all app data?')
  } else if (name === EVENT_ACCESS_PERSONAL_PERMISSION && eKind === BROAD_EVENT_KIND) {
    text = translate('Can I access all personal data?')
  } else {
    const dataType = getEventKindText(eKind, translate)
    if (name === EVENT_ACCESS_PERMISSION) text = translate('Can I access {{dataType}}?', { dataType })
    else if (name === EVENT_ACCESS_PERSONAL_PERMISSION) text = translate('Can I access personal copies of {{dataType}}?', { dataType })
    else text = translate('Can I {{action}} {{dataType}}?', { action: name, dataType })
  }

  const scope = getScopeText(meta?.scope, eKind, translate)
  if (!scope) return text
  const punctuation = /[?？]$/.test(text) ? text.slice(-1) : ''
  const question = punctuation ? text.slice(0, -1) : text
  return `${question} (${scope})${punctuation}`
}

function createPermissionDialogStore () {
  return {
    isOpen$ () { return this.queue$().length > 0 },
    close () {
      let lengthSnapshot = this.queue$().length
      let promise = Promise.resolve()
      while (lengthSnapshot-- > 0) {
        promise = promise.then(() => this.resolveCurrent(false))
      }
    },
    queue$: [],
    getPermissionId (req) { return `${req.app.id}:${req.name}:${req.eKind ?? ''}` },
    isSingularPermission (req) {
      return req.remember === false || req.eKind == null || (req.app.id && req.name === 'openApp')
    },
    addPermissionRequest (req) {
      this.queue$(v => {
        let duplicate
        if (
          !this.isSingularPermission(req) &&
          (duplicate = v.find(v2 => v2.id === req.id))
        ) {
          duplicate.promise.then(req.resolve).catch(req.reject)
          return v
        }

        v.push({
          id: req.id,
          app: {
            id: req.app.id,
            napp: req.app.napp,
            alias: req.app.alias,
            name: req.app.name,
            icon: {
              fx: req.app.icon?.fx,
              url: req.app.icon?.url
            }
          },
          name: req.name,
          eKind: req.eKind,
          meta: {
            // params: req.meta.params (NIP07)
            // targetApp: req.meta.targetApp (OPEN_APP)
            ...req.meta
          },
          promise: req.promise,
          resolve: req.resolve,
          reject: req.reject
        })
        return v
      })
    },
    removeCurrent (current) {
      if (this.queue$().length === 0) return

      const req = current ?? this.queue$()[0]
      this.queue$(v => current
        ? v.filter(v2 => v2.id !== req.id)
        : v.slice(1)
      )
    },
    async resolveCurrent (granted, current) {
      if (this.queue$().length === 0) return

      const req = current ?? this.queue$()[0]
      if (granted) {
        // grant just once
        if (this.isSingularPermission(req)) {
          req.resolve(true)
          this.removeCurrent(current)
          return
        }

        // remember
        await createOrUpdatePermission(req.app.id, req.name, req.eKind)
        req.resolve(true)
        this.removeCurrent(current)
      } else {
        req.reject(new Error('Permission denied'))
        this.removeCurrent(current)
      }
    },
    async queryPermission (req) {
      if (this.isSingularPermission(req)) return false
      return hasPermission(req.app.id, req.name, req.eKind)
    },
    async requestPermission (req) {
      const granted = await this.queryPermission(req)
      if (granted) return true

      const p = Promise.withResolvers()
      this.addPermissionRequest({
        ...req,
        ...p,
        id: this.isSingularPermission(req)
          ? `${this.getPermissionId(req)}:${Date.now()}:${Math.random()}`
          : this.getPermissionId(req)
      })
      return p.promise
    }
  }
}

export function usePermissionDialogStore () {
  return useGlobalStore('<permission-dialog>', createPermissionDialogStore)
}

// On the nip07 handler, call await pdStore.requestPermission(req)
f('permissionDialog', function () {
  const pdStore = usePermissionDialogStore()
  const modalProps = useStore(() => ({
    isOpen$: pdStore.isOpen$,
    close: pdStore.close.bind(pdStore),
    shouldAlwaysDisplay$: true,
    render: useCallback(function () {
      return this.h`<permission-dialog-stack />`
    })
  }))

  return this.h`<a-modal props=${modalProps} />`
})

f('permissionDialogStack', function () {
  const storage = useWebStorage(localStorage)
  const pdStore = usePermissionDialogStore()
  const store = useClosestStore('<permission-dialog-stack>', () => ({
    resolveCurrent: pdStore.resolveCurrent.bind(pdStore),
    getPermissionText (name, eKind, meta) {
      return formatPermissionText({
        name,
        eKind,
        meta,
        getCachedAppName: appId => storage[`session_appById_${appId}_name$`]()
      })
    },
    permissionRequests$ () {
      return pdStore.queue$()
    }
  }))

  return this.h`
    <style>${/* css */`
      #permission-dialog-stack {
        &${cssStrings.defaultTheme}

        display: flex;
        flex-direction: column;
        padding: 4px;
        min-width: 200px;
        @media ${jsVars.breakpoints.desktop} {
          margin: 0 auto;
          max-width: 500px;
        }
        background-color: ${cssVars.colors.bg2Lighter};
        color: ${cssVars.colors.fg2};
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        overflow: hidden;

        @media ${jsVars.breakpoints.mobile} {
          border-radius: 0;
        }
      }
      /* this fixes syntax highlight */
    `}</style>
    <div id='permission-dialog-stack' class=${cssClasses.defaultTheme}>
      ${store.permissionRequests$().map((req, index) => this.h({ key: req.id })`
        <f-to-signals
          props=${{
            from: ['req', 'index'], req, index, render ({ h, props: { req$, index$ } }) {
              return h`<permission-dialog-card
                props=${{
                  req$,
                  index$
                }}
              />`
            }
          }}
        />
      `)}
    </div>
  `
})

f('permissionDialogCard', function () {
  const storage = useWebStorage(localStorage)
  const pdsStore = useClosestStore('<permission-dialog-stack>')
  const store = useStore(() => ({
    req$: this.props.req$,
    index$: this.props.index$,
    resolveCurrent (granted) { return pdsStore.resolveCurrent(granted, this.req$()) },
    isButtonsDisabled$: false,
    allow () {
      this.isButtonsDisabled$(true)
      return this.resolveCurrent(true)
    },
    deny () {
      this.isButtonsDisabled$(true)
      return this.resolveCurrent(false)
    },
    permissionText$ () {
      const req = this.req$()
      return pdsStore.getPermissionText(req.name, req.eKind, req.meta)
    },
    appName$ () {
      const req = this.req$()
      const {
        [`session_appById_${req.app.id}_name$`]: cachedAppName$
      } = storage
      const cachedAppName = cachedAppName$()
      return req.app.name || cachedAppName || req.app.alias || req.app.napp || t('App')
    }
  }))
  const appIconProps = useStore(() => ({
    app$: () => ({
      id: store.req$().app.id,
      index: '?'
    })
  }))
  return this.h`
    <style>${`
      .permission-dialog-card {
        border-radius: 8px;
        display: flex;
        align-items: flex-start;
        padding: 5px 8px;
        transition: background-color 0.2s;

        &:hover {
          background-color: rgba(255, 255, 255, 0.05);
        }

        .app-icon {
          margin-right: 12px;
          flex-shrink: 0;
          width: 40px;
          height: 40px;
          position: relative;
          overflow: hidden;
          border-radius: 10px;
          background-color: ${cssVars.colors.bgAvatar};
          color: ${cssVars.colors.fg3};
        }

        .app-info {
          flex: 1;
          min-width: 0;
          margin-right: 10px;
          top: 1px;
          position: relative;
        }

        .app-name {
          font-size: 15rem;
          font-weight: 600;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .permission-text {
          font-size: 16rem;
          line-height: 1.3;
          color: rgba(255, 255, 255, 0.7);
          margin-top: 2px;
          display: -webkit-box;
          -webkit-box-orient: vertical;
          -webkit-line-clamp: 3;
          overflow: hidden;
          overflow-wrap: anywhere;
        }

        .permission-actions {
          display: flex;
          align-self: flex-start;
          gap: 8px;
          margin-left: 8px;
          padding-top: 2px;
        }

        .permission-button {
          padding: 6px 12px;
          border-radius: 4px;
          font-size: 14rem;
          font-weight: 500;
          cursor: pointer;
          transition: background-color 0.2s, opacity 0.2s;
          border: none;
        }

        .permission-button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .allow-button {
          background-color: ${cssVars.colors.bgAccentPrimary};
          color: ${cssVars.colors.fgAccent};
        }

        .allow-button:hover:not(:disabled) {
          background-color: ${cssVars.colors.bgPrimary};
        }

        .deny-button {
          background-color: transparent;
          color: ${cssVars.colors.fg2};
          display: flex;
          align-items: center;
          justify-content: center;
          width: 32px;
          height: 32px;
          padding: 0;
        }

        .deny-button:hover:not(:disabled) {
          background-color: rgba(255, 255, 255, 0.1);
        }

        .deny-button svg {
          width: 16px;
          height: 16px;
        }

        @media ${jsVars.breakpoints.mobile} {
          .permission-dialog-card {
            border-radius: 2px;
            padding: 8px 12px;
          }

          .app-icon {
            overflow: hidden;
            border-radius: 10px;
            width: 32px;
            height: 32px;
            margin-right: 10px;
          }

          .app-name {
            font-size: 14rem;
          }

          .permission-text {
            font-size: 16rem;
          }

          .permission-actions {
            gap: 6px;
          }

          .permission-button {
            padding: 4px 8px;
            font-size: 13rem;
          }

          .deny-button {
            width: 28px;
            height: 28px;
          }

          .deny-button svg {
            width: 14px;
            height: 14px;
          }
        }
      }
    `}</style>
    <div class='permission-dialog-card'>
      <div class="app-icon">
        <app-icon props=${appIconProps} />
      </div>
      <div class="app-info">
        <div class="app-name">${store.appName$()}</div>
        <div class="permission-text">${store.permissionText$()}</div>
      </div>
      <div class="permission-actions">
        <button
          class="permission-button allow-button"
          onclick=${store.allow}
          disabled=${store.isButtonsDisabled$()}
        >
          ${t('Allow')}
        </button>
        <button
          class="permission-button deny-button"
          onclick=${store.deny}
          disabled=${store.isButtonsDisabled$()}
        >
          <icon-x props=${{ size: '16px' }} />
        </button>
      </div>
    </div>
  `
})
