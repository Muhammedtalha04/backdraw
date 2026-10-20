> **Work in progress:** this project is being rebranded to Backdraw. Full documentation is coming.

# Claude ↔ ChatGPT Görsel Köprüsü

Claude Code, Chrome'da zaten giriş yapmış olduğun ChatGPT hesabınla görsel üretir.
OpenAI API anahtarı ya da ek ücret gerekmez. Her şey bilgisayarında çalışır.

```
Claude Code ──(MCP, stdio)──> mcp-server.js ──(yerel named pipe)──> host.js ──(Chrome native messaging)──> Chrome eklentisi
                                                                                                              │
                         arka plan sekmesi: chatgpt.com → seçili Proje → yeni sohbet → görsel ←───────────────┘
```

## Seni rahatsız etmez

- İşler, eklentinin kendi açtığı **arka plan sekmesinde** yürür. Aktif sekmen değişmez,
  Chrome öne gelmez, pencere odağı alınmaz.
- Fare ve klavye kullanılmaz. Sekmenin içinde yalnızca sayfaya özel (sentetik) DOM olayları kullanılır.
- Sekme sessize alınır. İş bitince sekme kapanır; o an o sekmeye bakıyorsan açık bırakılır.
- Şifre, cookie veya oturum anahtarı okunmaz, dışarı çıkarılmaz. Dışarı çıkan tek şey
  istem, ilerleme durumu, sohbet bağlantısı ve görselin kendisi.
- Giriş ekranı ya da CAPTCHA çıkarsa atlatılmaya çalışılmaz. Claude'a "NEEDS USER ACTION" bildirilir.
  O sekmeye geçip işlemi sen tamamlarsın; iş 10 dakika boyunca kendiliğinden devam etmeyi bekler.

## Claude'a nasıl söylenir

Claude Code'da yeni bir oturum aç ve doğal dille iste:

- `ChatGPT ile Riftora için mor-siyah void büyücüsü konsept görseli üret.`
- `ChatGPT ile bunu 16:9 manzara olarak üret ve assets/concepts klasörüne de kaydet.`
- `Şu görseli ChatGPT ile düzenle: sadece gözleri kapat.` (Claude görseli `reference_images` ile ekler.)
- `Bu karakter sayfasını referans alarak aynı karakterin büst sprite'ını üret.`
- `ChatGPT görsel işinin durumu ne?` / `O işi iptal et.`

Araçlar (`chatgpt-images` MCP sunucusu):

| Araç | Ne yapar |
|---|---|
| `generate_image` | Seçili projede yeni sohbet açıp görsel üretir. Sonucu bekler; dosya yolunu, önizlemeyi ve sohbet bağlantısını döndürür. `reference_images` yerel görselleri (en fazla 4) mesaja ekler; düzenleme ve karakter tutarlılığı için en güvenilir yol budur. `conversation_url` o sohbette devam eder. `auto_reattach` açıksa ChatGPT "görseli tekrar yükle" derse görseli kendisi ekleyip bir kez daha sorar. `output_dir` ile ek bir klasöre kopyalar. |
| `job_status` | Bir işin durumunu gösterir (istenirse bekler). `job_id` verilmezse köprünün genel durumunu gösterir. |
| `cancel_job` | Kuyruktaki ya da çalışan işi iptal eder. Gerekirse ChatGPT'de Durdur'a basar. |
| `fetch_images` | Var olan bir ChatGPT sohbetindeki son görselleri mesaj göndermeden indirir. Zaman aşımına uğramış işleri kurtarmak için kullanılır. |
| `list_projects` / `select_project` | ChatGPT projelerini listeler; görsellerin üretileceği projeyi seçer ve hatırlar. |

Sonuç türleri (Claude bunları okuyup ona göre davranır):

- **SUCCESS**: Görsel kaydedildi. Düzenleme isteklerinde bir **düzenleme kontrolü** satırı da gelir. Görselin
  referansa/önceki görsele ne kadar benzediğini ölçer: gerçek bir düzenleme ~%95-100 aynı kalır. ChatGPT düzenlemek yerine
  baştan çizdiyse `⚠ EDIT CHECK (edited: false)` uyarısı çıkar.
- **NEEDS REFERENCE IMAGE**: ChatGPT düzenlemesi gereken görsele erişemediğini söyleyip tekrar yüklenmesini istedi
  (uzun sohbetlerde olur). Sonuçta o sohbetten daha önce kaydedilmiş görsellerin yolları listelenir. Claude aynı istemi
  tekrar göndermez; görseli `reference_images` ile, tercihen yeni bir sohbette ekler.
- **CHATGPT REPLIED WITHOUT AN IMAGE**: ChatGPT görsel yerine metinle cevap verdi (soru, ret, limit). Metnin tamamı Claude'a gelir.

Tüm görseller her zaman `Resimler\ChatGPT Görselleri` klasörüne kaydedilir. `output_dir` verildiğinde ek bir kopya da oraya gider.
Dosya adı tarih ve istemden oluşur.

## Kurulum (bir kez)

1. `node install.js` komutunu çalıştır. Dosyaları `%USERPROFILE%\.claude\chatgpt-image-bridge` klasörüne kopyalar,
   Chrome native messaging kaydını yapar ve Claude Code'a `chatgpt-images` MCP sunucusunu ekler (kullanıcı düzeyi).
2. Chrome'da `chrome://extensions` sayfasını aç. **Geliştirici modu**nu aç, **Paketlenmemiş öğe yükle**ye bas
   ve `%USERPROFILE%\.claude\chatgpt-image-bridge\extension` klasörünü seç.
3. Görsel projesini seç. İki yol var:
   - ChatGPT'de projeyi aç, eklenti simgesine tıkla, **“…” projesini kullan** düğmesine bas.
   - Ya da Claude'a söyle: `ChatGPT görsel projesi olarak Claude Görselleri'ni seç.`

Not: Claude masaüstü uygulaması bir MSIX paketi olarak çalışır ve `AppData`'ya yapılan yazmaları kendi sanal alanına
yönlendirir. Kurulum bu yüzden `.claude` altına yapılır, Chrome kaydı da WMI ile gerçek kayıt defterine yazılır.

## Durum ve sorun giderme

```
node cli.js status                 # Chrome bağlı mı, hangi proje seçili, kuyruk
node cli.js generate "istem"       # Claude'suz deneme
node cli.js generate "sadece gözleri kapat" --ref görsel.png   # referansla düzenleme
node cli.js collect <sohbet linki> # mevcut sohbetten görsel indir
node cli.js debug on               # ayrıntılı kayıt: logs\host.log
node cli.js diagnose [link]        # ChatGPT sayfa yapısının özeti (arayüz değişirse)
```

- **"Bridge not running"**: Chrome kapalı ya da eklenti devre dışı. Chrome açılınca eklenti kendiliğinden bağlanır.
- Eklenti simgesindeki **!** işareti, yerel köprüye bağlanamadığını gösterir. `node install.js` komutunu tekrar çalıştır.
- ChatGPT arayüzü değişirse seçiciler `extension\inpage.js` dosyasında. `diagnose` çıktısı neyin değiştiğini gösterir.
  Düzelttikten sonra `node install.js` çalışan eklentiyi de yeniden yükler.

## Güncelleme / kaldırma

- Güncelleme: `node install.js` (çalışan eklentiyi de yeniden yükler).
- Kaldırma: `node install.js --uninstall`, ardından eklentiyi `chrome://extensions` sayfasından kaldır.
