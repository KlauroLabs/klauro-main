const STORAGE_KEY = "klauro_cookie_consent_v1";
const DEFAULT_CONSENT = {
  necessary: true,
  analytics: false,
  marketing: false,
};

function readConsent() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    return {
      ...DEFAULT_CONSENT,
      ...saved,
      necessary: true,
    };
  } catch {
    return null;
  }
}

function saveConsent(consent) {
  const value = {
    ...DEFAULT_CONSENT,
    ...consent,
    necessary: true,
    updatedAt: new Date().toISOString(),
  };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  window.klauroConsent.state = value;
  window.dispatchEvent(new CustomEvent("klauro-consent-change", { detail: value }));
  loadConsentedScripts(value);
  return value;
}

function loadConsentedScripts(consent) {
  document.querySelectorAll("script[type='text/plain'][data-consent]").forEach((placeholder) => {
    const category = placeholder.getAttribute("data-consent");
    if (!category || !consent[category] || placeholder.dataset.loaded === "true") return;

    const script = document.createElement("script");
    Array.from(placeholder.attributes).forEach((attribute) => {
      if (["type", "data-consent", "data-src", "data-loaded"].includes(attribute.name)) return;
      script.setAttribute(attribute.name, attribute.value);
    });
    script.type = "text/javascript";
    const src = placeholder.getAttribute("data-src");
    if (src) script.src = src;
    if (placeholder.textContent) script.textContent = placeholder.textContent;
    placeholder.dataset.loaded = "true";
    placeholder.after(script);
  });
}

function setPanelMode(panel, mode) {
  panel.dataset.mode = mode;
  panel.querySelector("[data-consent-summary]").hidden = mode !== "summary";
  panel.querySelector("[data-consent-preferences]").hidden = mode !== "preferences";
}

function closeBanner(banner) {
  banner.classList.add("is-leaving");
  window.setTimeout(() => banner.remove(), 180);
}

function createConsentBanner() {
  const banner = document.createElement("section");
  banner.className = "consent-shell";
  banner.setAttribute("aria-label", "Cookie consent");
  banner.innerHTML = `
    <div class="consent-card" data-mode="summary">
      <div class="consent-copy" data-consent-summary>
        <p class="consent-eyebrow">Privacy choices</p>
        <h2>Choose how Klauro uses cookies.</h2>
        <p>
          We use necessary storage to remember your choice. Optional analytics or marketing tools only load
          if you allow them.
        </p>
      </div>
      <div class="consent-preferences" data-consent-preferences hidden>
        <div>
          <p class="consent-eyebrow">Preferences</p>
          <h2>Manage optional cookies.</h2>
        </div>
        <label class="consent-toggle">
          <span>
            <strong>Necessary</strong>
            <small>Required for this choice to work.</small>
          </span>
          <input type="checkbox" checked disabled />
        </label>
        <label class="consent-toggle">
          <span>
            <strong>Analytics</strong>
            <small>Helps us understand aggregate site usage.</small>
          </span>
          <input type="checkbox" data-consent-input="analytics" />
        </label>
        <label class="consent-toggle">
          <span>
            <strong>Marketing</strong>
            <small>Reserved for future campaign measurement.</small>
          </span>
          <input type="checkbox" data-consent-input="marketing" />
        </label>
      </div>
      <div class="consent-actions">
        <button class="consent-link" type="button" data-consent-customize>Customize</button>
        <button class="button secondary" type="button" data-consent-reject>Reject optional</button>
        <button class="button primary" type="button" data-consent-accept>Accept all</button>
        <button class="button primary" type="button" data-consent-save hidden>Save choices</button>
      </div>
    </div>
  `;

  const panel = banner.querySelector(".consent-card");
  const customizeButton = banner.querySelector("[data-consent-customize]");
  const saveButton = banner.querySelector("[data-consent-save]");
  const acceptButton = banner.querySelector("[data-consent-accept]");
  const rejectButton = banner.querySelector("[data-consent-reject]");

  customizeButton.addEventListener("click", () => {
    setPanelMode(panel, "preferences");
    customizeButton.hidden = true;
    acceptButton.hidden = true;
    saveButton.hidden = false;
    banner.querySelector("[data-consent-input='analytics']").focus();
  });

  acceptButton.addEventListener("click", () => {
    saveConsent({ analytics: true, marketing: true });
    closeBanner(banner);
  });

  rejectButton.addEventListener("click", () => {
    saveConsent({ analytics: false, marketing: false });
    closeBanner(banner);
  });

  saveButton.addEventListener("click", () => {
    saveConsent({
      analytics: banner.querySelector("[data-consent-input='analytics']").checked,
      marketing: banner.querySelector("[data-consent-input='marketing']").checked,
    });
    closeBanner(banner);
  });

  document.body.appendChild(banner);
}

const initialConsent = readConsent();

window.klauroConsent = {
  state: initialConsent || DEFAULT_CONSENT,
  canUse(category) {
    return Boolean(this.state?.[category]);
  },
  update: saveConsent,
  reset() {
    window.localStorage.removeItem(STORAGE_KEY);
    window.location.reload();
  },
};

if (initialConsent) {
  loadConsentedScripts(initialConsent);
} else {
  createConsentBanner();
}
