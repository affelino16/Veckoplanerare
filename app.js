const SUPABASE_URL = "https://drzyjwbopnbpjoqmeixx.supabase.co";
const SUPABASE_KEY = "sb_publishable_GdZIIO1CvM3cih48CZrGHg_k1NPWUe7";

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);


// ========================================
// GLOBALA VARIABLER
// ========================================

let currentUser = null;
let currentProfile = null;
let profileNames = {}; // id -> namn
let profiles = [];     // [{ id, name }]

// Vilken kolumn i tabellen Schema som innehåller texten ("vad händer").
// Heter den fortfarande "title" hos dig: ändra här.
const SCHEDULE_TEXT_COLUMN = "title";

// Hur stor del av en utgift den andra personen är skyldig.
// 1 = hela beloppet, 0.5 = hälften (vanlig Splitwise-delning)
const OTHER_OWES_SHARE = 1;

const DAY_NAMES = ["Måndag", "Tisdag", "Onsdag", "Torsdag", "Fredag", "Lördag", "Söndag"];
const MONTH_NAMES = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];


// ========================================
// ELEMENT
// ========================================

const loginSection = document.getElementById("login-section");
const app = document.getElementById("app");
const loginForm = document.getElementById("login-form");
const logoutButton = document.getElementById("logout-button");
const loginMessage = document.getElementById("login-message");


// ========================================
// VECKA
// ========================================

function getMonday(d) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
    return x;
}

function addDays(d, n) {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
}

// Datum -> "2026-10-08" (lokal tid, inte UTC)
function toISO(d) {
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${m}-${day}`;
}

// "2026-10-08" -> Date (lokal tid)
function fromISO(s) {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d);
}

function isoWeekNumber(d) {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
}

function shortDate(d) {
    return `${d.getDate()} ${MONTH_NAMES[d.getMonth()]}`;
}

// Måndagen i den vecka som visas
let weekStart = getMonday(new Date());

function renderWeekTitle() {
    const end = addDays(weekStart, 6);
    const week = isoWeekNumber(weekStart);
    const year = addDays(weekStart, 3).getFullYear();

    document.getElementById("week-title").textContent =
        `Vecka ${week} · ${shortDate(weekStart)} – ${shortDate(end)} ${year}`;
}

async function changeWeek(newStart) {
    weekStart = newStart;
    renderWeekTitle();
    await loadSchedule();
    await loadMeals();
}


// ========================================
// HJÄLPFUNKTIONER
// ========================================

function el(tag, text, className) {
    const e = document.createElement(tag);
    if (text !== undefined && text !== null) e.textContent = text;
    if (className) e.className = className;
    return e;
}

// created_by avgör vems schema en rad hör till.
function createdByField() {
    return { created_by: currentUser.id };
}

function deleteButton(table, id, reload) {
    const btn = el("button", "Ta bort");
    btn.type = "button";
    btn.addEventListener("click", async () => {
        if (!confirm("Vill du ta bort det här?")) return;

        const { error } = await sb.from(table).delete().eq("id", id);

        if (error) {
            console.error(error);
            alert("Kunde inte ta bort: " + error.message);
            return;
        }
        await reload();
    });
    return btn;
}

// Ta bort genom att högerklicka (eller hålla ned på mobil).
// Funkar bara om den inloggade äger raden (ownerId).
function enableContextDelete(element, table, id, reload, ownerId) {
    if (!currentUser || ownerId !== currentUser.id) return;

    element.classList.add("deletable");
    element.title = "Högerklicka (eller håll ned) för att ta bort";

    let busy = false;
    let timer = null;

    const doDelete = async () => {
        if (busy) return;
        busy = true;

        try {
            if (!confirm("Vill du ta bort det här?")) return;

            const { error } = await sb.from(table).delete().eq("id", id);

            if (error) {
                console.error(error);
                alert("Kunde inte ta bort: " + error.message);
                return;
            }
            await reload();
        } finally {
            busy = false;
        }
    };

    element.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        clearTimeout(timer);
        doDelete();
    });

    // Långt tryck för mobil
    element.addEventListener("touchstart", () => {
        timer = setTimeout(doDelete, 700);
    }, { passive: true });

    ["touchend", "touchmove", "touchcancel"].forEach(type => {
        element.addEventListener(type, () => clearTimeout(timer), { passive: true });
    });
}

function emptyMessage(container, text) {
    container.appendChild(el("p", text));
}

function money(n) {
    return n.toLocaleString("sv-SE", { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + " kr";
}

// Bygger sju dagrutor (mån–sön) för vald vecka.
function buildWeekGrid(container, items, renderItem) {
    container.innerHTML = "";
    const todayISO = toISO(new Date());

    for (let i = 0; i < 7; i++) {
        const date = addDays(weekStart, i);
        const iso = toISO(date);

        const day = el("div", null, "day" + (iso === todayISO ? " today" : ""));

        const h = el("h4", DAY_NAMES[i] + " ");
        h.appendChild(el("span", shortDate(date), "date"));
        day.appendChild(h);

        items
            .filter(item => item.date === iso)
            .forEach(item => day.appendChild(renderItem(item)));

        container.appendChild(day);
    }
}

// ========================================
// REALTID (LYSSNA PÅ DATABASEN)
// ========================================

function setupRealtime() {
    sb.channel('hushall-kanal')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'Inköpslista' }, () => {
            loadShoppingList();
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'Schema' }, () => {
            loadSchedule();
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'Matmeny' }, () => {
            loadMeals();
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'Utgifter' }, () => {
            loadExpenses();
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'Betalningar' }, () => {
            loadExpenses(); // Balance uppdateras också här
        })
        .subscribe((status) => {
            if (status === 'SUBSCRIBED') console.log('Realtid aktiverad!');
        });
}

// ========================================
// STARTA APPEN
// ========================================

async function init() {
    const { data, error } = await sb.auth.getSession();

    if (error) {
        console.error(error);
        return;
    }

    if (data.session) {
        currentUser = data.session.user;
        await loadProfile();
        showApp();
        await loadAllData();
        setupRealtime();
    } else {
        showLogin();
    }
}


// ========================================
// AUTH
// ========================================

async function login(email, password) {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });

    if (error) {
        console.error(error);
        loginMessage.textContent = error.message;
        return;
    }

    loginMessage.textContent = "";
    currentUser = data.user;

    await loadProfile();
    showApp();
    await loadAllData();
    setupRealtime();
}

async function logout() {
    const { error } = await sb.auth.signOut();

    if (error) {
        console.error(error);
        return;
    }

    currentUser = null;
    currentProfile = null;
    showLogin();
}


// ========================================
// PROFIL
// ========================================

async function loadProfile() {
    const { data, error } = await sb
        .from("Profiler")
        .select("*")
        .eq("id", currentUser.id)
        .single();

    if (error) {
        console.error("Profilfel:", error);
        return;
    }

    currentProfile = data;
    document.getElementById("welcome").textContent = `Hej ${currentProfile.name}!`;
}


// ========================================
// VISA / GÖM
// ========================================

function showLogin() {
    loginSection.hidden = false;
    app.hidden = true;
}

function showApp() {
    loginSection.hidden = true;
    app.hidden = false;
}


// ========================================
// LADDA ALL DATA
// ========================================

async function loadAllData() {
    renderWeekTitle();
    await loadProfiles();
    setScheduleDayDefault();
    await loadSchedule();
    await loadShoppingList();
    await loadMeals();
    await loadExpenses();
}


// ========================================
// SCHEMA (EN KOLUMN PER PERSON)
// ========================================

function setScheduleDayDefault() {
    // Förvälj dagens veckodag (måndag = 0)
    document.getElementById("schedule-day").value = String((new Date().getDay() + 6) % 7);
}

async function loadSchedule() {
    const { data, error } = await sb
        .from("Schema")
        .select("*")
        .gte("date", toISO(weekStart))
        .lte("date", toISO(addDays(weekStart, 6)))
        .order("date", { ascending: true });

    if (error) {
        console.error(error);
        return;
    }

    const container = document.getElementById("schedule-list");
    container.innerHTML = "";

    if (profiles.length === 0) {
        emptyMessage(container, "Inga profiler hittades.");
        return;
    }

    const todayISO = toISO(new Date());

    const table = document.createElement("table");
    table.className = "schedule-table";

    // Rubrikrad: en kolumn per person
    const headRow = table.createTHead().insertRow();
    headRow.appendChild(el("th", ""));
    profiles.forEach(p => {
        const isMe = currentUser && p.id === currentUser.id;
        headRow.appendChild(el("th", isMe ? `${p.name} (du)` : p.name));
    });

    // En rad per veckodag
    const body = table.createTBody();

    for (let i = 0; i < 7; i++) {
        const date = addDays(weekStart, i);
        const iso = toISO(date);

        const row = body.insertRow();
        if (iso === todayISO) row.className = "today";

        row.appendChild(el("th", `${DAY_NAMES[i]} ${shortDate(date)}`));

        profiles.forEach(p => {
            const cell = row.insertCell();

            data
                .filter(item => item.date === iso && item.created_by === p.id)
                .forEach(item => {
                    const div = el("div", null, "entry");
                    div.appendChild(el("span", item[SCHEDULE_TEXT_COLUMN]));
                    enableContextDelete(div, "Schema", item.id, loadSchedule, item.created_by);
                    cell.appendChild(div);
                });
        });
    }

    container.appendChild(table);
}

async function addSchedule() {
    const dayIndex = Number(document.getElementById("schedule-day").value);
    const date = toISO(addDays(weekStart, dayIndex));
    const text = document.getElementById("schedule-name").value;

    const { error } = await sb
        .from("Schema")
        .insert({
            date: date,
            [SCHEDULE_TEXT_COLUMN]: text,
            ...createdByField()
        });

    if (error) {
        console.error(error);
        alert("Kunde inte lägga till: " + error.message);
        return;
    }

    document.getElementById("schedule-name").value = "";
    await loadSchedule();
}

// ========================================
// INKÖPSLISTA
// ========================================

async function loadShoppingList() {
    const { data, error } = await sb
        .from("Inköpslista")
        .select("*")
        .order("completed", { ascending: true });

    if (error) {
        console.error(error);
        return;
    }

    const list = document.getElementById("shopping-list");
    list.innerHTML = "";

    if (data.length === 0) {
        emptyMessage(list, "Inköpslistan är tom.");
        return;
    }

    const ul = document.createElement("ul");

    data.forEach(item => {
        const li = document.createElement("li");

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = !!item.completed;
        checkbox.addEventListener("change", async () => {
            const { error } = await sb
                .from("Inköpslista")
                .update({ completed: checkbox.checked })
                .eq("id", item.id);

            if (error) {
                console.error(error);
                alert("Kunde inte uppdatera: " + error.message);
            }
            await loadShoppingList();
        });

        const label = el("span", " " + item.name + " ");
        if (item.completed) label.style.textDecoration = "line-through";

        li.appendChild(checkbox);
        li.appendChild(label);
        li.appendChild(deleteButton("Inköpslista", item.id, loadShoppingList));
        ul.appendChild(li);
    });

    list.appendChild(ul);
}

async function addShoppingItem() {
    const name = document.getElementById("shopping-name").value;

    const { error } = await sb
        .from("Inköpslista")
        .insert({
            name: name,
            ...createdByField()
        });

    if (error) {
        console.error(error);
        alert("Kunde inte lägga till: " + error.message);
        return;
    }

    document.getElementById("shopping-form").reset();
    await loadShoppingList();
}

// ========================================
// MATMENY (MÅN–SÖN, VISAR BARA VALD VECKA)
// ========================================

async function loadMeals() {
    const { data, error } = await sb
        .from("Matmeny")
        .select("*")
        .gte("date", toISO(weekStart))
        .lte("date", toISO(addDays(weekStart, 6)))
        .order("date", { ascending: true });

    if (error) {
        console.error(error);
        return;
    }

    const container = document.getElementById("meal-list");

    buildWeekGrid(container, data, item => {
        const div = el("div", null, "entry");
        div.appendChild(el("strong", item.meal));
        div.appendChild(deleteButton("Matmeny", item.id, loadMeals));
        return div;
    });
}

async function addMeal() {
    const dayIndex = Number(document.getElementById("meal-day").value);
    const date = toISO(addDays(weekStart, dayIndex));

    const meal = document.getElementById("meal-name").value;

    const { error } = await sb
        .from("Matmeny")
        .insert({
            date: date,
            meal: meal
        });

    if (error) {
        console.error(error);
        alert("Kunde inte lägga till: " + error.message);
        return;
    }

    document.getElementById("meal-name").value = "";
    await loadMeals();
}


// ========================================
// PROFILER
// ========================================

async function loadProfiles() {
    let { data, error } = await sb
        .from("Profiler")
        .select("id, name, phone")
        .order("name");

    if (error) {
        // Kolumnen "phone" kanske inte finns än: försök utan den
        ({ data, error } = await sb
            .from("Profiler")
            .select("id, name")
            .order("name"));
    }

    if (error) {
        console.error("Fel när profiler hämtades:", error);
        return;
    }

    profiles = data;
    profileNames = {};
    data.forEach(p => { profileNames[p.id] = p.name; });

    setExpenseDefaults();
}

// Datum = idag
function setExpenseDefaults() {
    document.getElementById("expense-date").value = toISO(new Date());
}

// ========================================
// UTGIFTER + SPLITWISE + SWISH
// ========================================

const SWISH_MESSAGE = "hej :)";

// "070-123 45 67" -> "46701234567"
function swishNumber(phone) {
    let d = String(phone || "").replace(/\D/g, "");
    if (d.startsWith("00")) d = d.slice(2);
    if (d.startsWith("0")) d = "46" + d.slice(1);
    return d;
}

// Länk som öppnar Swish-appen med allt ifyllt (fungerar på mobilen)
function swishLink(number, amount) {
    const payload = {
        version: 1,
        payee: { value: number, editable: false },
        amount: { value: amount, editable: false },
        message: { value: SWISH_MESSAGE, editable: true }
    };
    return "swish://payment?data=" + encodeURIComponent(JSON.stringify(payload));
}

// Hämtar en officiell Swish-QR via vår Edge Function "swish-qr"
// (Swish tillåter inte anrop direkt från webbläsaren)
async function showSwishQr(container, number, amount) {
    container.textContent = "Hämtar QR-kod...";

    try {
        const { data, error } = await sb.functions.invoke("swish-qr", {
            body: { payee: number, amount: amount, message: SWISH_MESSAGE }
        });

        if (error) throw error;
        if (!data || !data.image) throw new Error(data && data.error ? data.error : "Inget svar");

        const img = document.createElement("img");
        img.src = data.image;
        img.alt = "Swish QR-kod";
        img.width = 220;

        container.innerHTML = "";
        container.appendChild(img);
    } catch (err) {
        console.error("Swish QR:", err);
        container.textContent =
            `Kunde inte hämta QR-koden: ${err.message}. Swisha ${money(amount)} till ${number} manuellt.`;
    }
}

async function settleDebt(fromId, toId, amount, details) {
    const text = amount > 0
        ? `Markera att ${profileNames[fromId]} har betalat ${money(amount)} till ${profileNames[toId]}?\n\nUtgifterna nollställs och sparas bara i historiken.`
        : "Nollställa utgifterna? De sparas bara i historiken.";
    if (!confirm(text)) return;

    // 1. Spara betalningen (historiken)
    const { data: payment, error } = await sb
        .from("Betalningar")
        .insert({ from_user: fromId, to_user: toId, amount: amount, details: details })
        .select()
        .single();

    if (error) {
        console.error(error);
        alert("Kunde inte spara betalningen: " + error.message);
        return;
    }

    // 2. Arkivera utgifterna som ingick (de försvinner ur listan)
    const { data: updated, error: updateError } = await sb
        .from("Utgifter")
        .update({ settled_in: payment.id })
        .in("bought_by", [fromId, toId])
        .is("settled_in", null)
        .select("id");

    if (updateError || !updated || updated.length === 0) {
        console.error(updateError);
        // Ångra betalningen så att inget blir halvt
        await sb.from("Betalningar").delete().eq("id", payment.id);
        alert("Kunde inte nollställa utgifterna. Kontrollera att kolumnen settled_in finns i Utgifter och att tabellen har en UPDATE-policy." +
            (updateError ? "\n\n" + updateError.message : ""));
        return;
    }

    await loadExpenses();
}

async function undoSettlement(id) {
    if (!confirm("Ångra betalningen? Utgifterna och skulden kommer tillbaka.")) return;

    // Utgifterna återställs automatiskt (settled_in blir tom när betalningen tas bort)
    const { error } = await sb.from("Betalningar").delete().eq("id", id);

    if (error) {
        console.error(error);
        alert("Kunde inte ångra: " + error.message);
        return;
    }
    await loadExpenses();
}

// Swish-knappar och "markera som betald" för en skuld
function renderPayActions(box, debtorId, creditorId, amount, details) {
    const wrap = el("div", null, "pay-actions");
    const creditor = profiles.find(p => p.id === creditorId);
    const number = swishNumber(creditor && creditor.phone);
    const iAmDebtor = currentUser && currentUser.id === debtorId;

    if (iAmDebtor) {
        if (!number) {
            wrap.appendChild(el("p", `${profileNames[creditorId]} har inget Swish-nummer. Lägg till kolumnen "phone" i Profiler.`));
        } else {
            const qrBox = el("div", null, "qr-box");

            const open = document.createElement("a");
            open.href = swishLink(number, amount);
            open.textContent = "Öppna Swish";
            open.className = "button-link";

            const qrBtn = el("button", "Visa QR-kod");
            qrBtn.type = "button";
            qrBtn.addEventListener("click", () => showSwishQr(qrBox, number, amount));

            wrap.appendChild(open);
            wrap.appendChild(document.createTextNode(" "));
            wrap.appendChild(qrBtn);
            wrap.appendChild(qrBox);
        }
    }

    const paidBtn = el("button", "Markera som betald");
    paidBtn.type = "button";
    paidBtn.addEventListener("click", () => settleDebt(debtorId, creditorId, amount, details));
    wrap.appendChild(document.createTextNode(" "));
    wrap.appendChild(paidBtn);

    box.appendChild(wrap);
}

function renderBalance(expenses, settlements) {
    const box = document.getElementById("balance");
    box.innerHTML = "";
    box.appendChild(el("h3", "Vem är skyldig vem?"));

    const ids = profiles.map(p => p.id);

    const paid = {}; // allt personen har betalat sedan senaste betalning
    ids.forEach(id => { paid[id] = 0; });

    // owed[skyldig][fordringsägare] = { sum, items: [] }
    const owed = {};

    expenses.forEach(e => {
        const amount = Number(e.amount) || 0;
        if (paid[e.bought_by] === undefined) return;

        paid[e.bought_by] += amount;

        // Alla andra än den som betalade hamnar i skuld
        const others = ids.filter(id => id !== e.bought_by);
        if (others.length === 0) return;

        const part = (amount * OTHER_OWES_SHARE) / others.length;

        others.forEach(other => {
            owed[other] = owed[other] || {};
            owed[other][e.bought_by] = owed[other][e.bought_by] || { sum: 0, items: [] };
            owed[other][e.bought_by].sum += part;
            owed[other][e.bought_by].items.push(`${e.item} ${money(part)}`);
        });
    });

    // Slutresultat per par (netto). Bara utgifter som inte är betalda ingår.
    let shownAny = false;

    for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
            const a = ids[i];
            const b = ids[j];

            const aOwesB = owed[a]?.[b] || { sum: 0, items: [] };
            const bOwesA = owed[b]?.[a] || { sum: 0, items: [] };

            if (aOwesB.sum === 0 && bOwesA.sum === 0) continue;
            shownAny = true;

            const detailLines = [];
            if (aOwesB.items.length) {
                detailLines.push(`${profileNames[a]} är skyldig ${profileNames[b]} (${money(aOwesB.sum)}): ` + aOwesB.items.join(", "));
            }
            if (bOwesA.items.length) {
                detailLines.push(`${profileNames[b]} är skyldig ${profileNames[a]} (${money(bOwesA.sum)}): ` + bOwesA.items.join(", "));
            }
            const detailText = detailLines.join("\n");

            // Positivt = a är skyldig b
            const net = Math.round((aOwesB.sum - bOwesA.sum) * 100) / 100;

            if (Math.abs(net) < 0.005) {
                box.appendChild(el("p", `${profileNames[a]} och ${profileNames[b]} är kvitt.`, "result"));

                const wrap = el("div", null, "pay-actions");
                const resetBtn = el("button", "Nollställ");
                resetBtn.type = "button";
                resetBtn.addEventListener("click", () => settleDebt(a, b, 0, detailText));
                wrap.appendChild(resetBtn);
                box.appendChild(wrap);
            } else {
                const debtor = net > 0 ? a : b;
                const creditor = net > 0 ? b : a;
                const amount = Math.abs(net);

                box.appendChild(el("p", `${profileNames[debtor]} är skyldig ${profileNames[creditor]} ${money(amount)}`, "result"));
                renderPayActions(box, debtor, creditor, amount, detailText);
            }

            const details = document.createElement("details");
            details.appendChild(el("summary", "Visa vad det består av"));
            detailLines.forEach(line => details.appendChild(el("p", line)));
            box.appendChild(details);
        }
    }

    if (!shownAny) {
        box.appendChild(el("p", "Ingen är skyldig någon något just nu.", "result"));
    }

    // Historik: sparas även efter att utgifterna nollställts
    if (settlements.length > 0) {
        const hist = document.createElement("details");
        hist.appendChild(el("summary", "Betalningar som gjorts"));

        const ul = document.createElement("ul");
        settlements.forEach(s => {
            const li = document.createElement("li");
            const when = s.created_at ? String(s.created_at).slice(0, 10) : "";
            const amountText = Number(s.amount) > 0 ? money(Number(s.amount)) : "nollställt";

            li.appendChild(el("span",
                `${when} ${profileNames[s.from_user] || "?"} → ${profileNames[s.to_user] || "?"}: ${amountText} `));

            const undo = el("button", "Ångra");
            undo.type = "button";
            undo.addEventListener("click", () => undoSettlement(s.id));
            li.appendChild(undo);

            if (s.details) {
                const d = el("div", s.details);
                d.style.whiteSpace = "pre-line";
                d.style.fontSize = ".85rem";
                d.style.color = "#666";
                li.appendChild(d);
            }
            ul.appendChild(li);
        });
        hist.appendChild(ul);
        box.appendChild(hist);
    }

    box.appendChild(el("h4", "Köpt sedan senaste betalning"));
    const totals = document.createElement("ul");
    ids.forEach(id => {
        totals.appendChild(el("li", `${profileNames[id]}: ${money(paid[id])}`));
    });
    box.appendChild(totals);
}

async function loadExpenses() {
    // Bara utgifter som inte är betalda än
    let { data, error } = await sb
        .from("Utgifter")
        .select("*")
        .is("settled_in", null)
        .order("date", { ascending: false });

    if (error) {
        // Kolumnen settled_in finns kanske inte än: visa alla
        console.warn("Kunde inte filtrera på settled_in:", error.message);
        ({ data, error } = await sb
            .from("Utgifter")
            .select("*")
            .order("date", { ascending: false }));
    }

    if (error) {
        console.error(error);
        return;
    }

    // Betalningshistorik
    let settlements = [];
    const res = await sb
        .from("Betalningar")
        .select("*")
        .order("created_at", { ascending: false });

    if (res.error) {
        console.warn("Betalningar kunde inte hämtas:", res.error.message);
    } else {
        settlements = res.data;
    }

    renderBalance(data, settlements);

    const list = document.getElementById("expenses-list");
    list.innerHTML = "";

    if (data.length === 0) {
        emptyMessage(list, "Inga utgifter ännu.");
        return;
    }

    const ul = document.createElement("ul");

    data.forEach(item => {
        const by = profileNames[item.bought_by] || "?";

        const li = document.createElement("li");
        let text = `${item.date} – ${item.item}: ${money(Number(item.amount))} (köpt av ${by})`;
        if (item.description) text += ` – ${item.description}`;
        li.appendChild(el("span", text));
        enableContextDelete(li, "Utgifter", item.id, loadExpenses, item.bought_by);
        ul.appendChild(li);
    });

    list.appendChild(ul);
}

async function addExpense() {
    const boughtBy = currentUser.id; // den som är inloggad
    const item = document.getElementById("expense-item").value;
    const amount = document.getElementById("expense-amount").value;
    const date = document.getElementById("expense-date").value;
    const description = document.getElementById("expense-description").value;

    const { error } = await sb
        .from("Utgifter")
        .insert({
            bought_by: boughtBy,
            item: item,
            amount: amount,
            date: date,
            description: description
        });

    if (error) {
        console.error(error);
        alert("Kunde inte lägga till: " + error.message);
        return;
    }

    document.getElementById("expense-form").reset();
    setExpenseDefaults();
    await loadExpenses();
}

// ========================================
// FORMULÄR OCH KNAPPAR
// ========================================

loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = document.getElementById("email").value;
    const password = document.getElementById("password").value;
    await login(email, password);
});

logoutButton.addEventListener("click", logout);

document.getElementById("prev-week").addEventListener("click", () => changeWeek(addDays(weekStart, -7)));
document.getElementById("next-week").addEventListener("click", () => changeWeek(addDays(weekStart, 7)));
document.getElementById("this-week").addEventListener("click", () => changeWeek(getMonday(new Date())));

document.getElementById("schedule-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    await addSchedule();
});

document.getElementById("shopping-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    await addShoppingItem();
});

document.getElementById("meal-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    await addMeal();
});

document.getElementById("expense-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    await addExpense();
});


// ========================================
// AUTH STATE
// ========================================

sb.auth.onAuthStateChange((event, session) => {
    if (session) {
        currentUser = session.user;
    } else {
        currentUser = null;
        currentProfile = null;
        showLogin();
    }
});


// ========================================
// START
// ========================================

init();