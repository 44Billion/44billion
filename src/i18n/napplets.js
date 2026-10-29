import { getT, SUPPORTED_LOCALES } from './index.js'

// Rows follow SUPPORTED_LOCALES; napplet is a format/product name.
const rows = [
  ['Play', 'Lire', 'Riproduci', 'Wiedergeben', 'Reproducir', 'Reproduzir', 'Воспроизвести', '播放', '播放', '再生', '재생'],
  ['Pause', 'Pause', 'Pausa', 'Pause', 'Pausa', 'Pausar', 'Пауза', '暂停', '暫停', '一時停止', '일시 정지'],
  ['Settings', 'Paramètres', 'Impostazioni', 'Einstellungen', 'Ajustes', 'Configurações', 'Настройки', '设置', '設定', '設定', '설정'],
  ['Save', 'Enregistrer', 'Salva', 'Speichern', 'Guardar', 'Salvar', 'Сохранить', '保存', '儲存', '保存', '저장'],
  ['Cancel', 'Annuler', 'Annulla', 'Abbrechen', 'Cancelar', 'Cancelar', 'Отмена', '取消', '取消', 'キャンセル', '취소'],
  ['Close', 'Fermer', 'Chiudi', 'Schließen', 'Cerrar', 'Fechar', 'Закрыть', '关闭', '關閉', '閉じる', '닫기'],
  ['Open link', 'Ouvrir le lien', 'Apri link', 'Link öffnen', 'Abrir enlace', 'Abrir link', 'Открыть ссылку', '打开链接', '開啟連結', 'リンクを開く', '링크 열기'],
  ['Install', 'Installer', 'Installa', 'Installieren', 'Instalar', 'Instalar', 'Установить', '安装', '安裝', 'インストール', '설치'],
  ['Open', 'Ouvrir', 'Apri', 'Öffnen', 'Abrir', 'Abrir', 'Открыть', '打开', '開啟', '開く', '열기'],
  ['Some features may be unavailable', 'Certaines fonctions peuvent être indisponibles', 'Alcune funzioni potrebbero non essere disponibili', 'Einige Funktionen sind möglicherweise nicht verfügbar', 'Algunas funciones pueden no estar disponibles', 'Alguns recursos podem estar indisponíveis', 'Некоторые функции могут быть недоступны', '部分功能可能不可用', '部分功能可能無法使用', '一部の機能が利用できない場合があります', '일부 기능을 사용하지 못할 수 있습니다'],
  ['Napplets', 'Napplets', 'Napplets', 'Napplets', 'Napplets', 'Napplets', 'Napplets', 'Napplets', 'Napplets', 'Napplets', 'Napplets'],
  ['Napplet', 'Napplet', 'Napplet', 'Napplet', 'Napplet', 'Napplet', 'Napplet', 'Napplet', 'Napplet', 'Napplet', 'Napplet'],
  ['Retry', 'Réessayer', 'Riprova', 'Erneut versuchen', 'Reintentar', 'Tentar novamente', 'Повторить', '重试', '重試', '再試行', '다시 시도'],
  ['Opening napplet…', 'Ouverture du napplet…', 'Apertura del napplet…', 'Napplet wird geöffnet…', 'Abriendo napplet…', 'Abrindo napplet…', 'Открытие napplet…', '正在打开 napplet…', '正在開啟 napplet…', 'Napplet を開いています…', 'Napplet 여는 중…'],
  ['Install sandboxed napplets and open them in your workspace.', 'Installez des napplets isolés et ouvrez-les dans votre espace de travail.', 'Installa napplet isolati e aprili nel tuo spazio di lavoro.', 'Installiere isolierte Napplets und öffne sie in deinem Arbeitsbereich.', 'Instala napplets aislados y ábrelos en tu espacio de trabajo.', 'Instale napplets isolados e abra-os no seu espaço de trabalho.', 'Устанавливайте изолированные napplet и открывайте их в рабочей области.', '安装沙盒 napplet 并在工作区中打开。', '安裝沙箱 napplet 並在工作區中開啟。', 'サンドボックス化された napplet をインストールしてワークスペースで開きます。', '격리된 napplet을 설치하고 작업 공간에서 여세요.'],
  ['Napplet reference', 'Référence du napplet', 'Riferimento napplet', 'Napplet-Referenz', 'Referencia del napplet', 'Referência do napplet', 'Ссылка на napplet', 'Napplet 引用', 'Napplet 參照', 'Napplet の参照', 'Napplet 참조'],
  ['Paste a napplet naddr or nevent', 'Collez le naddr ou nevent du napplet', 'Incolla il naddr o nevent del napplet', 'Napplet-naddr oder -nevent einfügen', 'Pega el naddr o nevent del napplet', 'Cole o naddr ou nevent do napplet', 'Вставьте naddr или nevent napplet', '粘贴 napplet 的 naddr 或 nevent', '貼上 napplet 的 naddr 或 nevent', 'Napplet の naddr または nevent を貼り付け', 'Napplet naddr 또는 nevent 붙여넣기'],
  ['Open napplet', 'Ouvrir le napplet', 'Apri napplet', 'Napplet öffnen', 'Abrir napplet', 'Abrir napplet', 'Открыть napplet', '打开 napplet', '開啟 napplet', 'Napplet を開く', 'Napplet 열기'],
  ['Search napplets', 'Rechercher des napplets', 'Cerca napplet', 'Napplets suchen', 'Buscar napplets', 'Buscar napplets', 'Поиск napplet', '搜索 napplet', '搜尋 napplet', 'Napplet を検索', 'Napplet 검색'],
  ['Refresh', 'Actualiser', 'Aggiorna', 'Aktualisieren', 'Actualizar', 'Atualizar', 'Обновить', '刷新', '重新整理', '更新', '새로 고침'],
  ['Loading napplets…', 'Chargement des napplets…', 'Caricamento dei napplet…', 'Napplets werden geladen…', 'Cargando napplets…', 'Carregando napplets…', 'Загрузка napplet…', '正在加载 napplet…', '正在載入 napplet…', 'Napplet を読み込んでいます…', 'Napplet 로딩 중…'],
  ['No napplets found. You can open one using its reference above.', 'Aucun napplet trouvé. Utilisez une référence ci-dessus pour en ouvrir un.', 'Nessun napplet trovato. Puoi aprirne uno usando il riferimento qui sopra.', 'Keine Napplets gefunden. Öffne eines über seine Referenz oben.', 'No se encontraron napplets. Puedes abrir uno con su referencia arriba.', 'Nenhum napplet encontrado. Use a referência acima para abrir um.', 'Napplet не найдены. Откройте один по ссылке выше.', '未找到 napplet。可使用上方引用打开。', '找不到 napplet。可使用上方參照開啟。', 'Napplet が見つかりません。上の参照を使って開けます。', 'Napplet을 찾을 수 없습니다. 위에 참조를 입력하여 여세요.'],
  ['Requires unsupported capabilities:', 'Fonctionnalités requises non prises en charge :', 'Funzionalità richieste non supportate:', 'Nicht unterstützte erforderliche Funktionen:', 'Requiere capacidades no compatibles:', 'Requer recursos não suportados:', 'Требуются неподдерживаемые возможности:', '需要不受支持的功能：', '需要不支援的功能：', '必要な未対応機能：', '지원되지 않는 필수 기능:'],
  ['Opening…', 'Ouverture…', 'Apertura…', 'Wird geöffnet…', 'Abriendo…', 'Abrindo…', 'Открытие…', '正在打开…', '正在開啟…', '開いています…', '여는 중…'],
  ['Install / Open', 'Installer / Ouvrir', 'Installa / Apri', 'Installieren / Öffnen', 'Instalar / Abrir', 'Instalar / Abrir', 'Установить / Открыть', '安装 / 打开', '安裝 / 開啟', 'インストール / 開く', '설치 / 열기']
]
export const nappletLocales = Object.fromEntries(rows.map(row => [row[0], Object.fromEntries(SUPPORTED_LOCALES.map((locale, index) => [locale, row[index]]))]))
export const nappletT = getT(nappletLocales)
