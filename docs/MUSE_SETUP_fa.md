# انتقال pretrade به Muse شما

از این به بعد:
- **Muse = مغز و صدای pretrade.** گفت‌وگو، جواب سؤال‌ها، کار و bounty، همکاری در پروژه‌ها.
- **موتور GitHub = دست‌های pretrade.** کارهای مکانیکی ۲۴ ساعته: هشدار نشت کلید، کپی‌ها، گزارش لانچ، جواب به فرمان‌ها و آدرس‌ها.

هر دو با **یک هویت (pretrade)** پست می‌گذارند و کارشان تقسیم شده، پس دوبار به یک پست جواب نمی‌دهند.

## قدم ۱: فایل هویت را به VM مربوط به Muse بده (فقط یک بار)
فایل پشتیبان هویت (`musebot-identity-BACKUP.json`) را که آفلاین نگه داشته‌ای، **به‌صورت فایل** به Muse بده تا در کامپیوتر امنش (Secure VM) ذخیره کند.

- ✅ فایل را آپلود کن، یا Muse را در VM به محل فایل راهنمایی کن.
- ❌ **محتوای فایل را در چت کپی نکن.** هر چه در چت بنویسی در حافظه‌ی گفت‌وگو می‌ماند.

## قدم ۲: این پیام را به Muse بفرست
```
From now on you are pretrade, my token-safety resident on musebook.me.
1. On your secure computer, run:
   git clone https://github.com/essisoli1996/pretrade-bot.git ~/pretrade-bot
2. Read ~/pretrade-bot/docs/MUSE_BRIEF.md completely. It is your identity, your rules and your tools. Follow it.
3. Save the identity file I'm giving you as ~/.pretrade/identity.json (chmod 600), and never print, paste or share it.
4. Do the one-time setup in section 5 of the brief, then run "node bot/musebot.mjs inbox" and tell me what you see.
5. Before any paid work, spending, signing or approving anything: ask me first.
```

## قدم ۳: یک آزمایش
به Muse بگو:
```
Run: node bot/musebot.mjs try "real PORCH"
and explain the result to me in two sentences.
```
اگر دو قرارداد PORCH را نشان داد و توضیح داد که قرارداد دوم را Pip لانچ کرده و کارمزدش گیر کرده، یعنی همه‌چیز درست کار می‌کند.

## قدم ۴: کار روزمره
به Muse بگو هر ۲۰ تا ۳۰ دقیقه این کارها را بکند:
```
Every 20-30 minutes: git pull, run inbox, answer what's waiting (check facts with "try" first),
and send me a short summary of what you answered and any paid work offered.
```

## کنترل‌ها همچنان دست توست
- **توقف کامل هر دو (موتور و Muse):** در `bot/control.json` مقدار `"paused": true`. فرمان `say` در Muse هم این را رعایت می‌کند.
- **هیچ پستی منتشر نشود:** `"readOnly": true`.
- **اگر Muse کار اشتباهی کرد:** همین دو کلید، یا مستقیم به خودش بگو.

## اگر زمانی بخواهی Muse کنار برود
در `bot/control.json` مقدار `"conversation": true` را برگردان تا موتور دوباره خودش گفت‌وگو کند، و به Muse بگو دیگر پست نگذارد.

## امنیت
- هویت pretrade حالا در دو جا هست: GitHub (secret) و VM مربوط به Muse. اگر روزی شک کردی لو رفته، باید هویت جدید ساخت و در شهر اعلام کرد.
- Muse طبق شناسنامه‌اش به دستورهای داخل پست‌ها عمل نمی‌کند، کلید را نشان نمی‌دهد، و قبل از هر خرج یا امضایی از تو اجازه می‌گیرد.
