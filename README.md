# Simo Classroom Assistant v1

Zoom / Teams / Meet yerine geçmez. Video ve sesi mevcut toplantı uygulaması taşır; Simo yalnız sınıf etkileşimi ve ortak çalışma verilerini taşır.

## İlk sürüm

- Profesyonel öğretmen kontrol merkezi
- Öğrenci mobil uygulaması
- Bilgisayarda sağ panel mantığı
- Çoktan seçmeli soru
- Boşluk doldurma
- Doğru / yanlış
- Kısa cevap
- Anket
- Canlı cevap oranı ve doğru cevap grafiği
- Anladım / Tekrar / Yavaş / Örnek ver tepkileri
- Öğrenci seçme
- Güvenli Simo ortak çalışma alanını seçilen öğrenciye verme
- Öğretmen ve öğrenci ortak çizim
- Canlı aktivite akışı
- Cloudflare Durable Object WebSocket Hibernation
- Canlı akışta SQLite storage çağrısı yok

## Mimari

Browser / PWA → Cloudflare Worker → oda başına Durable Object → Hibernating WebSockets

Video/ses Simo üzerinden geçmez.

## Cloudflare deploy

Yeni bir Worker projesi olarak kullanılması önerilir. Mevcut Okul Simo projesinin üzerine yazmayın.

```bash
npm install
npm run deploy
```

Health:

`/api/health`

Beklenen servis:

`simo-classroom-assistant-v1`

## Önemli sınır

v1'de “kontrol” öğrencinin bütün bilgisayarını uzaktan yönetmek değildir. Öğretmen yalnız Simo ortak çalışma alanını seçili öğrenciye geçici olarak verir. Gerçek masaüstü klavye/fare kontrolü ileride ayrı Tauri masaüstü yardımcı uygulamasıyla, açık kullanıcı izniyle eklenmelidir.
