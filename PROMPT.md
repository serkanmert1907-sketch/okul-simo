# Simo Classroom Assistant — Ana Geliştirme Promptu

Simo Classroom Assistant adında Zoom, Teams veya Meet yanında çalışan; video ve ses taşımayan; hafif, profesyonel ve gerçek zamanlı bir öğretmen–öğrenci etkileşim sistemi geliştir.

## Ürün amacı

Zoom'un yerine geçme. Zoom görüntü ve sesi taşımaya devam etsin. Simo öğretmenin yanında çalışan sınıf kontrol ve etkileşim katmanı olsun. Öğretmenin ders anlatmasını bölmeden öğrencilerle soru, tepki, ortak çalışma ve canlı katılım sağlamalı.

## Tasarım

- WordPress/admin-template görünümünden kaçın.
- Modern premium SaaS kalitesinde tasarım kullan.
- Koyu lacivert navigasyon, beyaz çalışma yüzeyi, tek ana vurgu rengi.
- Temiz tipografi ve geniş nefes alan boşluklar.
- Profesyonel veri kartları ve gerçek zamanlı SVG grafikler.
- Hafif mikro animasyonlar; gösterişli ama ağır efektler kullanma.
- Desktop, tablet ve mobil tamamen responsive olsun.
- Öğretmen için Zoom yanında küçülebilen hızlı kontrol çubuğu bulunmalı.

## Öğretmen özellikleri

- Canlı sınıf oda kodu / katılım linki.
- Bağlı öğrenci sayısı.
- Cevap oranı.
- Doğru cevap oranı.
- Sınıf nabzı.
- Çoktan seçmeli soru.
- Boşluk doldurma.
- Doğru / yanlış.
- Kısa cevap.
- Anket.
- Cevabı sonradan gösterme.
- Öğrenci listesi ve öğrenci seçme.
- Anladım / tekrar et / yavaş / örnek ver tepkileri.
- Canlı aktivite akışı.
- Canlı cevap/katılım grafiği.
- Seçilen öğrenciye güvenli Simo ortak çalışma alanının geçici kontrolünü verme.
- Öğretmen ve öğrenci ortak çizim yapabilsin.

## Öğrenci deneyimi

### Bilgisayar
- Sol taraf Zoom / ders için boş bırakılabilsin.
- Sağda Simo etkileşim paneli çalışsın.
- Yeni soru geldiğinde panel görünür ve odaklı olsun.

### Mobil
- Simo paneli tam ekran çalışsın.
- Soru cevaplama hızlı ve tek elle kullanılabilir olsun.
- Tepki düğmeleri sürekli ulaşılabilir olsun.

## Teknik mimari

- Video/ses Simo üzerinden geçmesin.
- Gerçek zamanlı küçük mesajlar için WebSocket kullan.
- Cloudflare Worker + oda başına Durable Object kullan.
- WebSocket Hibernation API kullan.
- Canlı sınıf akışında Durable Object SQLite storage yazısı yapma.
- Bağlantı metadatasını WebSocket attachment içinde tut.
- Hibernation sonrası öğretmenden tekrar senkron isteyerek geçici workspace state'ini geri kur.
- Ağ mesajlarını küçük tut.

## Güvenlik / kontrol

- v1'de öğrencinin bütün bilgisayarını uzaktan yönetme.
- Yalnız Simo ortak çalışma yüzeyinin kontrolünü öğrenciye ver.
- Kontrol açıkça görünür ve öğretmen tarafından anında kapatılabilir olsun.
- Gerçek masaüstü kontrolü gerekiyorsa bunu daha sonra açık kullanıcı izni isteyen Tauri masaüstü yardımcı uygulamasıyla ekle.

## Öncelik sırası

1. Stabil gerçek zamanlı bağlantı.
2. Soru-cevap.
3. Mobil öğrenci deneyimi.
4. Desktop öğrenci sağ paneli.
5. Tepkiler ve canlı grafikler.
6. Öğrenci seçme ve ortak çalışma alanı.
7. Sonraki sürümlerde AI soru üretme, grup modu, yarışma ve ders sonu raporu.
