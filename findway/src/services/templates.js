'use strict';
// Transactional email copy. Interface text is translated; user-entered content is interpolated untouched.
const T = {
  otp_verify_email: {
    en: ['Your FIND WAY verification code', 'Your FIND WAY verification code is {code}. It expires in {minutes} minutes. If you did not request it, ignore this email.'],
    ar: ['رمز التحقق الخاص بك في FIND WAY', 'رمز التحقق الخاص بك هو {code}. تنتهي صلاحيته خلال {minutes} دقائق. إذا لم تطلبه فتجاهل هذه الرسالة.'],
    sq: ['Kodi juaj i verifikimit në FIND WAY', 'Kodi juaj i verifikimit është {code}. Skadon pas {minutes} minutash. Nëse nuk e keni kërkuar, shpërfilleni këtë email.'],
    fr: ['Votre code de vérification FIND WAY', 'Votre code de vérification est {code}. Il expire dans {minutes} minutes. Si vous ne l’avez pas demandé, ignorez cet e-mail.'],
  },
  otp_recover_password: {
    en: ['Reset your FIND WAY password', 'Your password reset code is {code}. It expires in {minutes} minutes. If you did not request it, you can ignore this email.'],
    ar: ['إعادة تعيين كلمة مرور FIND WAY', 'رمز إعادة تعيين كلمة المرور هو {code}. تنتهي صلاحيته خلال {minutes} دقائق. إذا لم تطلبه فتجاهل هذه الرسالة.'],
    sq: ['Rivendosni fjalëkalimin tuaj FIND WAY', 'Kodi për rivendosjen e fjalëkalimit është {code}. Skadon pas {minutes} minutash. Nëse nuk e keni kërkuar, shpërfilleni.'],
    fr: ['Réinitialisez votre mot de passe FIND WAY', 'Votre code de réinitialisation est {code}. Il expire dans {minutes} minutes. Si vous ne l’avez pas demandé, ignorez cet e-mail.'],
  },
  account_exists: {
    en: ['FIND WAY sign-up attempt', 'Someone tried to register this email address, but an account already exists. You can sign in or reset your password.'],
    ar: ['محاولة تسجيل في FIND WAY', 'حاول شخص ما التسجيل بهذا البريد لكن الحساب موجود بالفعل. يمكنك تسجيل الدخول أو إعادة تعيين كلمة المرور.'],
    sq: ['Përpjekje regjistrimi në FIND WAY', 'Dikush provoi të regjistrojë këtë email, por llogaria ekziston tashmë. Mund të hyni ose të rivendosni fjalëkalimin.'],
    fr: ['Tentative d’inscription FIND WAY', 'Quelqu’un a tenté d’inscrire cette adresse, mais un compte existe déjà. Vous pouvez vous connecter ou réinitialiser votre mot de passe.'],
  },
  account_decision: {
    en: ['Your FIND WAY account review', 'Your account status is now: {status}. {note}'],
    ar: ['مراجعة حسابك في FIND WAY', 'حالة حسابك الآن: {status}. {note}'],
    sq: ['Shqyrtimi i llogarisë suaj FIND WAY', 'Statusi i llogarisë tuaj tani është: {status}. {note}'],
    fr: ['Examen de votre compte FIND WAY', 'Le statut de votre compte est maintenant : {status}. {note}'],
  },
  staff_invite: {
    en: ['You have been added to FIND WAY CRM', 'An administrator created a FIND WAY CRM account for you. Use “Forgot password” with this email to set your password.'],
    ar: ['تمت إضافتك إلى FIND WAY CRM', 'أنشأ المسؤول حساباً لك في FIND WAY CRM. استخدم «نسيت كلمة المرور» بهذا البريد لتعيين كلمة المرور.'],
    sq: ['Jeni shtuar në FIND WAY CRM', 'Një administrator ju krijoi një llogari në FIND WAY CRM. Përdorni “Harrova fjalëkalimin” me këtë email për të vendosur fjalëkalimin.'],
    fr: ['Vous avez été ajouté à FIND WAY CRM', 'Un administrateur a créé votre compte FIND WAY CRM. Utilisez « Mot de passe oublié » avec cet e-mail pour définir votre mot de passe.'],
  },
};
function render(template, locale, params) {
  const t = T[template]; if (!t) throw new Error(`unknown template ${template}`);
  const [subject, body] = t[locale] || t.en;
  const fill = (s) => s.replace(/\{(\w+)\}/g, (_, k) => (params[k] === undefined ? '' : String(params[k])));
  return { subject: fill(subject), text: fill(body) };
}
module.exports = { render };
