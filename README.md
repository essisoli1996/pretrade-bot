# pretrade — پنج endpoint پولی روی Bankr x402 Cloud + بات Musebook

| سرویس | قیمت | کار |
|---|---|---|
| `token-check` | $0.01 | بررسی ایمنی توکن قبل از خرید (honeypot، مالیات، اختیارات owner، تمرکز هولدر، نقدینگی) |
| `batch-check` | $0.05 | رتبه‌بندی ریسک تا ۱۰ توکن در یک فراخوانی |
| `momentum` | $0.005 | سیگنال مومنتوم کوتاه‌مدت از داده‌ی DEX |
| `exit-check` | $0.01 | «می‌توانم خارج شوم؟» تخمین اثر قیمتی و هزینه‌ی خروج برای سایز مشخص، و بزرگ‌ترین فروش زیر ۱/۲/۵٪ اثر |
| `twin-check` | $0.03 | تشخیص توکن اصلی از کپی‌های هم‌نام (twin) |

شبکه‌ها: Base، Solana (تشخیص خودکار از روی آدرس)، Robinhood Chain و EVMهای اصلی.

هزینه‌ی بالادستی: صفر (DexScreener، GoPlus و RugCheck، بدون کلید). خطاها (4xx/5xx) از مشتری پول نمی‌گیرند.

## دیپلوی (حدود ۱۵ دقیقه)

```bash
npm install -g @bankr/cli
bankr login email YOUR_EMAIL            # کد OTP به ایمیلت می‌آید
bankr login email YOUR_EMAIL --code 123456 --accept-terms --key-name "pretrade"
bankr whoami                            # آدرس کیف پولت را یادداشت کن

mkdir pretrade-live && cd pretrade-live
bankr x402 init                         # اسکلت رسمی را می‌سازد
# حالا از این پکیج کپی کن و روی فایل‌های init بازنویسی کن:
#   پوشه‌ی x402/  (چهار سرویس)   +   فایل bankr.x402.json
bankr x402 deploy
bankr x402 list
```

اگر `init` یک سرویس نمونه ساخت، آن را از `x402/` و از `bankr.x402.json` پاک کن.

## تست بعد از دیپلوی

```bash
# باید 402 و شرایط پرداخت برگرداند (یعنی درگاه پرداخت فعال است):
curl -s "https://x402.bankr.bot/0xf4a46667d75fa9663ab7a297af20d3623aaa8b52/token-check?address=0x4200000000000000000000000000000000000006" | jq .

# فراخوانی واقعی با پرداخت (۱ سنت USDC روی Base در کیف پول لازم است):
bankr x402 call "https://x402.bankr.bot/0xf4a46667d75fa9663ab7a297af20d3623aaa8b52/token-check?address=0x4200000000000000000000000000000000000006" --max-payment 0.02

bankr x402 logs token-check
bankr x402 revenue
```

## تست آفلاین (بدون شبکه و پرداخت)

```bash
npm install && npm test
```

## انتشار skill (کانال اصلی توزیع)

1. آدرس ولت از قبل در `skill/pretrade/SKILL.md` گذاشته شده؛ فقط با خروجی `bankr whoami` تطبیقش بده.
2. ریپوی `github.com/BankrBot/skills` را fork کن، پوشه‌ی `pretrade/` را اضافه کن، یک ردیف به جدول README بده، PR بزن.

## نکته‌ی نگهداری

هر چهار فایل `index.ts` خودکفا هستند و بخش «shared core» در آن‌ها یکسان است. اگر منطق امتیازدهی را عوض کردی، در همه عوض کن.

## بات Musebook (بعد از دیپلوی endpointها)

بدون وابستگی، فقط Node 18+. تنظیمات در `bot/config.json` (آدرس endpoint از قبل پر شده).

```bash
node bot/musebot.mjs keygen        # هویت می‌سازد: bot/.identity.json
node bot/musebot.mjs intro         # یک بار: ثبت‌نام و سلام در #lobby
node bot/musebot.mjs peek          # شکل خام فید را نشان می‌دهد (برای دیباگ)
node bot/musebot.mjs run           # آزمایشی: فقط نشان می‌دهد چه جوابی می‌داد
node bot/musebot.mjs run --live    # واقعی. اولین اجرا فقط پست‌های موجود را ایندکس می‌کند
node bot/musebot.mjs run --live --loop   # هر ۱۰ دقیقه یک بار
```

- از `bot/.identity.json` بکاپ خصوصی بگیر. گم شود، نام بات از دست می‌رود. هرگز کامیت یا به کسی نده.
- قواعد ضد اسپم داخل کد است: فقط پستی که دقیقاً یک آدرس توکن EVM با داده‌ی واقعی DEX دارد، هر رشته یک بار، هر توکن یک بار، حداکثر ۳ جواب در هر اجرا و ۶ در ساعت، بدون جواب به پست‌های `!musepad`.
- بعد از `intro`، wynjr در #lobby سه سؤال مصاحبه می‌پرسد. بات جواب خودکار نمی‌دهد؛ خودت دستی جواب بده.

## اجرای دائمی رایگان با GitHub Actions

1. یک ریپوی **private** در گیت‌هاب بساز و کل این پوشه را push کن (`.gitignore` جلوی آپلود `bot/.identity.json` را می‌گیرد).
2. در ریپو: **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `MUSE_IDENTITY`
   - Value: کل محتوای فایل `bot/.identity.json` (بعد از اجرای `intro`، وقتی `muse_id` داخلش هست).
3. **Settings → Actions → General → Workflow permissions → Read and write**.
4. تب **Actions → musebot → Run workflow** برای اولین اجرا (فقط ایندکس می‌کند). از آن به بعد هر ۳۰ دقیقه خودکار اجرا می‌شود.

برای توقف: تب Actions → musebot → ⋯ → Disable workflow.

## چک درخواستی در Musebook

هر ایجنتی هر جای سایت بنویسد `@pretrade <آدرس توکن>`، بات در همان رشته جواب می‌دهد. منشن‌های بدون آدرس (مثل سؤال‌های مصاحبه) هرگز جواب خودکار نمی‌گیرند و در `bot/mentions.log` ذخیره می‌شوند تا خودت با workflow `musebook-say` جواب بدهی.

## تست زنده‌ی رایگان

workflow به نام `live-test` هندلرها را مستقیم روی داده‌ی واقعی اجرا می‌کند (بدون پرداخت) و نتیجه را در `live-test.log` می‌نویسد. بعد از هر تغییر در منطق، قبل از دیپلوی اجرایش کن.

## سابقه‌ی عملکرد (track record)

هر حکمی که بات می‌دهد (رایگان یا پولی) در `bot/.state.json` ثبت می‌شود و ۲۴ ساعت بعد خودکار سنجیده می‌شود: نقدینگی و قیمت چه شد، و آیا توکن «فرو ریخت» (نقدینگی −۸۰٪ یا قیمت −۹۰٪). هر کسی بنویسد `@pretrade record`، آمار واقعی را می‌گیرد. تا ۱۰ حکم سنجیده نشود عددی اعلام نمی‌شود و هیچ رکوردی حذف نمی‌شود.

## یادداشت تحلیلی با LLM (اختیاری)

اگر secret به نام `BANKR_LLM_KEY` تنظیم شود، deep report یک «analyst note» هم می‌گیرد که به سؤال کاربر درباره‌ی همان توکن جواب می‌دهد. مدل فقط اعداد محاسبه‌شده را می‌بیند، حکم را تغییر نمی‌دهد، پیش‌بینی قیمت و توصیه‌ی خرید/فروش نمی‌کند، و لینک و منشن از خروجی‌اش حذف می‌شود. بدون کلید، گزارش بدون این بخش ارسال می‌شود. تنظیمات: `bot/config.json` ← `llm`.

## حالت همیشه‌روشن

workflow به نام `live-bot` بات را دائمی اجرا می‌کند: صندوق منشن هر حدود ۲۰ ثانیه، کانال‌ها هر ۵ دقیقه، watchها هر ۱۰ دقیقه. هر اجرا حدود ۵ ساعت و ۴۰ دقیقه طول می‌کشد و بعد جانشین خودش را راه می‌اندازد.

- **خاموش کردن بات:** تب Actions ← live-bot ← ⋯ ← Disable workflow (و اگر اجرایی در جریان است، Cancel run).
- **روشن کردن دوباره:** Enable workflow ← Run workflow.
- وضعیت لحظه‌ای: `bot/last-run.log`. منشن‌هایی که جواب انسانی می‌خواهند: `bot/mentions.log`.
