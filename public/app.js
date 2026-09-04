const TOKEN_STORAGE_KEY = "anniversary_session_token";
const state = {
  items: [],
  filter: "all",
  toastTimer: null,
  token: localStorage.getItem(TOKEN_STORAGE_KEY) || "",
  user: null,
  serviceWorkerRegistration: null,
  pushSubscription: null,
  vapidPublicKey: "",
  pullStartY: 0,
  pullStartX: 0,
  pullDistance: 0,
  pullTracking: false,
  pullRefreshing: false,
  openSwipeId: null,
  spotlightId: null,
  liveDateKey: "",
  lunarMonths: [],
  lunarOptionsRequest: 0,
  recurrenceRefreshing: false,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const dialog = $("#anniversary-dialog");
const form = $("#anniversary-form");
const loginForm = $("#login-form");

const dateFormatter = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" });
const solarPreviewFormatter = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "short" });

function localDate(dateString) {
  return new Date(`${dateString}T00:00:00`);
}

function eventDateTime(item) {
  const recurringCountdown = item.mode === "countdown" && item.repeat_rule && item.repeat_rule !== "once";
  const dateString = recurringCountdown ? (item.next_occurrence_date || item.event_date) : item.event_date;
  const timeString = recurringCountdown ? (item.next_occurrence_time || item.event_time) : item.event_time;
  const [year, month, day] = dateString.split("-").map(Number);
  const [hour, minute, second] = (timeString || "00:00:00").split(":").map(Number);
  return new Date(year, month - 1, day, hour || 0, minute || 0, second || 0);
}

function durationFor(item, now = Date.now()) {
  const target = eventDateTime(item).getTime();
  const signedMilliseconds = item.mode === "countdown" ? target - now : now - target;
  const totalSeconds = Math.max(0, Math.floor(Math.abs(signedMilliseconds) / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const label = item.mode === "countdown"
    ? (signedMilliseconds >= 0 ? "倒计时" : "已经过去")
    : (signedMilliseconds >= 0 ? "已累计" : "距离开始");
  return {
    target,
    signedMilliseconds,
    days,
    clock: `${String(hours).padStart(2, "0")}时${String(minutes).padStart(2, "0")}分${String(seconds).padStart(2, "0")}秒`,
    label,
  };
}

function getFutureCountdowns(now = Date.now()) {
  return state.items
    .filter((item) => item.mode === "countdown" && eventDateTime(item).getTime() >= now)
    .sort((a, b) => eventDateTime(a) - eventDateTime(b));
}

function displayDate(dateString) {
  return dateFormatter.format(localDate(dateString));
}

function dateValue(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function todayDateValue() {
  return dateValue(new Date());
}

function lunarDayLabel(day) {
  const digits = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
  if (day <= 10) return `初${digits[day - 1]}`;
  if (day < 20) return `十${digits[day - 11]}`;
  if (day === 20) return "二十";
  if (day < 30) return `廿${digits[day - 21]}`;
  return "三十";
}

function lunarMonthLabel(month, isLeap = false) {
  const names = ["正月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "冬月", "腊月"];
  return `${isLeap ? "闰" : ""}${names[month - 1] || `${month}月`}`;
}

function displayCalendarDate(item) {
  if (item.calendar_type !== "lunar") return displayDate(item.event_date);
  return `农历${item.lunar_year}年${lunarMonthLabel(item.lunar_month, item.lunar_is_leap)}${lunarDayLabel(item.lunar_day)} · 公历${displayDate(item.event_date)}`;
}

function repeatRuleLabel(rule) {
  return ({ once: "仅一次", yearly: "每年", monthly: "每月", daily: "每日" })[rule] || "仅一次";
}

function displayEventDateTime(item) {
  if (item.mode === "countdown" && item.repeat_rule && item.repeat_rule !== "once") {
    const nextDate = item.next_occurrence_date || item.event_date;
    const nextTime = item.next_occurrence_time || item.event_time || "00:00:00";
    let lunarRule = "";
    if (item.calendar_type === "lunar" && item.repeat_rule === "yearly") {
      lunarRule = ` · 农历${lunarMonthLabel(item.lunar_month, item.lunar_is_leap)}${lunarDayLabel(item.lunar_day)}`;
    } else if (item.calendar_type === "lunar" && item.repeat_rule === "monthly") {
      lunarRule = ` · 农历${lunarDayLabel(item.lunar_day)}`;
    }
    return `${repeatRuleLabel(item.repeat_rule)}${lunarRule} · 下一次 ${solarPreviewFormatter.format(localDate(nextDate))} ${nextTime}`;
  }
  return `${displayCalendarDate(item)} ${item.event_time || "00:00:00"}`;
}

function getReminderText(item) {
  if (!item.reminder_enabled) return "提醒已关闭";
  const frequency = item.reminder_type === "times" ? `最多 ${item.max_reminders} 次` : "每天提醒";
  const advance = item.mode === "countdown" ? `提前 ${item.advance_days} 天` : "每天记录";
  const channels = [item.web_push_enabled ? "系统通知" : "", item.webhook_url ? "企业微信" : ""].filter(Boolean);
  return `${advance} · ${item.reminder_time} · ${frequency} · ${channels.join(" + ") || "未选通道"}`;
}

function setTodayLabel() {
  const today = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(new Date());
  $("#today-label").textContent = today;
  $("#calendar-day").textContent = new Date().getDate();
}

function renderSpotlight(now = Date.now()) {
  const item = getFutureCountdowns(now)[0];
  const target = $("#spotlight");
  state.spotlightId = item?.id ?? null;
  if (!item) {
    target.innerHTML = `<p class="spotlight-name">还没有临近的倒计时</p><p class="spotlight-value">从容<span>安排每一个重要日子</span></p>`;
    return;
  }
  const duration = durationFor(item, now);
  target.innerHTML = `
    <p class="spotlight-name">${escapeHtml(item.title)}</p>
    <div class="spotlight-duration" data-duration-id="${item.id}">
      <span class="spotlight-days"><strong data-duration-days>${duration.days}</strong><span>天</span></span>
      <span class="spotlight-clock" data-duration-clock>${duration.clock}</span>
    </div>
    <p class="spotlight-date"><span data-duration-label>${duration.label}</span> · ${displayEventDateTime(item)} · 已设置 ${item.advance_days} 天前提醒</p>`;
}

function renderSummary(nowTimestamp = Date.now()) {
  const future = getFutureCountdowns(nowTimestamp);
  const now = new Date(nowTimestamp);
  const monthly = future.filter((item) => {
    const eventDate = eventDateTime(item);
    return eventDate.getFullYear() === now.getFullYear() && eventDate.getMonth() === now.getMonth();
  });
  $("#total-count").textContent = state.items.length;
  $("#month-count").textContent = monthly.length;
  $("#webhook-count").textContent = state.items.filter((item) => item.webhook_url).length;
}

function escapeHtml(value) {
  const element = document.createElement("span");
  element.textContent = value;
  return element.innerHTML;
}

function cardMarkup(item) {
  const channelText = [item.web_push_enabled ? "系统通知" : "", item.webhook_url ? "企业微信" : ""].filter(Boolean).join(" + ");
  const activeTag = item.reminder_enabled
    ? `<span class="reminder-tag">${channelText || "未选通道"}</span>`
    : `<span class="reminder-tag" style="color:#8b918d;background:#eff0ed">提醒已暂停</span>`;
  const duration = durationFor(item);
  return `
    <div class="anniversary-swipe" data-swipe-id="${item.id}">
      <div class="swipe-action swipe-edit-action"><button type="button" data-swipe-edit="${item.id}">编辑</button></div>
      <div class="swipe-action swipe-delete-action"><button type="button" data-swipe-delete="${item.id}">删除</button></div>
      <article class="anniversary-card" style="--item-accent:${item.accent}" data-id="${item.id}">
        <span class="card-accent"></span>
        <div class="card-title">
          <h3>${escapeHtml(item.title)}</h3>
          <div class="card-meta"><span>${item.mode === "countdown" ? "倒计时" : "纪念总时长"}</span><span class="tiny-dot"></span><span>${displayEventDateTime(item)}</span>${activeTag}</div>
        </div>
        <p class="card-reminder">${escapeHtml(getReminderText(item))}</p>
        <div class="card-count" data-duration-id="${item.id}">
          <div class="card-duration-main"><strong data-duration-days>${duration.days}</strong><span>天</span></div>
          <span class="card-duration-clock" data-duration-clock>${duration.clock}</span>
          <span class="card-duration-label" data-duration-label>${duration.label}</span>
        </div>
      </article>
    </div>`;
}

function renderList() {
  const visible = state.filter === "all" ? state.items : state.items.filter((item) => item.mode === state.filter);
  const target = $("#anniversary-list");
  if (!visible.length) {
    target.innerHTML = `<div class="empty-state"><strong>这里还没有纪念日</strong><span>先为一个值得期待的日子设下提醒吧。</span><br><button class="primary-button" id="empty-create-button" type="button"><span>＋</span>新建纪念日</button></div>`;
    $("#empty-create-button").addEventListener("click", () => openDialog());
    return;
  }
  const sorted = [...visible].sort((a, b) => {
    const now = Date.now();
    const aTarget = eventDateTime(a).getTime();
    const bTarget = eventDateTime(b).getTime();
    const aOrder = a.mode === "countdown" && aTarget >= now ? aTarget - now : Number.MAX_SAFE_INTEGER;
    const bOrder = b.mode === "countdown" && bTarget >= now ? bTarget - now : Number.MAX_SAFE_INTEGER;
    return aOrder - bOrder;
  });
  target.innerHTML = sorted.map(cardMarkup).join("");
  bindSwipeCards();
}

const SWIPE_ACTION_WIDTH = 82;

function setSwipePosition(container, offset, animate = true) {
  const card = $(".anniversary-card", container);
  const boundedOffset = Math.max(-SWIPE_ACTION_WIDTH, Math.min(SWIPE_ACTION_WIDTH, offset));
  card.classList.toggle("is-swiping", !animate);
  card.style.setProperty("--swipe-x", `${boundedOffset}px`);
  container.dataset.swipeOffset = String(boundedOffset);
  container.classList.toggle("is-open", boundedOffset !== 0);
  return boundedOffset;
}

function closeOpenSwipe(exceptId = null) {
  if (state.openSwipeId === null || state.openSwipeId === exceptId) return;
  const openContainer = $(`[data-swipe-id="${state.openSwipeId}"]`);
  if (openContainer) setSwipePosition(openContainer, 0);
  state.openSwipeId = null;
}

function bindSwipeCards() {
  state.openSwipeId = null;
  $$(".anniversary-swipe").forEach((container) => {
    const card = $(".anniversary-card", container);
    const id = Number(container.dataset.swipeId);
    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let startOffset = 0;
    let currentOffset = 0;
    let isHorizontal = false;
    let suppressClick = false;

    card.addEventListener("pointerdown", (event) => {
      if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
      closeOpenSwipe(id);
      pointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      startOffset = Number(container.dataset.swipeOffset || 0);
      currentOffset = startOffset;
      isHorizontal = false;
      suppressClick = false;
      card.setPointerCapture?.(pointerId);
    });

    card.addEventListener("pointermove", (event) => {
      if (event.pointerId !== pointerId) return;
      const deltaX = event.clientX - startX;
      const deltaY = event.clientY - startY;
      if (!isHorizontal) {
        if (Math.abs(deltaX) < 6 && Math.abs(deltaY) < 6) return;
        if (Math.abs(deltaY) >= Math.abs(deltaX)) {
          pointerId = null;
          return;
        }
        isHorizontal = true;
        suppressClick = true;
      }
      if (event.cancelable) event.preventDefault();
      currentOffset = setSwipePosition(container, startOffset + deltaX, false);
    });

    const finishSwipe = (event) => {
      if (event.pointerId !== pointerId) return;
      pointerId = null;
      if (card.hasPointerCapture?.(event.pointerId)) card.releasePointerCapture(event.pointerId);
      if (!isHorizontal) return;
      const finalOffset = currentOffset > 34
        ? SWIPE_ACTION_WIDTH
        : currentOffset < -34
          ? -SWIPE_ACTION_WIDTH
          : 0;
      setSwipePosition(container, finalOffset);
      state.openSwipeId = finalOffset === 0 ? null : id;
      setTimeout(() => { suppressClick = false; }, 320);
    };

    card.addEventListener("pointerup", finishSwipe);
    card.addEventListener("pointercancel", finishSwipe);
    card.addEventListener("click", (event) => {
      if (suppressClick) {
        event.preventDefault();
        event.stopPropagation();
      } else if (Number(container.dataset.swipeOffset || 0) !== 0) {
        setSwipePosition(container, 0);
        state.openSwipeId = null;
      }
    });

    $("[data-swipe-edit]", container).addEventListener("click", () => {
      setSwipePosition(container, 0);
      state.openSwipeId = null;
      openDialog(id);
    });
    $("[data-swipe-delete]", container).addEventListener("click", async () => {
      setSwipePosition(container, 0);
      state.openSwipeId = null;
      await deleteAnniversaryById(id);
    });
  });
}

function render() {
  renderSpotlight();
  renderSummary();
  renderList();
}

function updateLiveDurations() {
  if (!state.user) return;
  const now = Date.now();
  const hasExpiredRecurrence = state.items.some((item) => (
    item.mode === "countdown"
    && item.repeat_rule
    && item.repeat_rule !== "once"
    && eventDateTime(item).getTime() < now
  ));
  if (hasExpiredRecurrence && !state.recurrenceRefreshing) {
    state.recurrenceRefreshing = true;
    loadItems().finally(() => { state.recurrenceRefreshing = false; });
  }
  const nextSpotlightId = getFutureCountdowns(now)[0]?.id ?? null;
  if (nextSpotlightId !== state.spotlightId) {
    renderSpotlight(now);
    renderSummary(now);
    renderList();
  }

  $$('[data-duration-id]').forEach((element) => {
    const item = state.items.find((entry) => entry.id === Number(element.dataset.durationId));
    if (!item) return;
    const duration = durationFor(item, now);
    const days = $('[data-duration-days]', element);
    const clock = $('[data-duration-clock]', element);
    const label = $('[data-duration-label]', element);
    if (days) days.textContent = duration.days;
    if (clock) clock.textContent = duration.clock;
    if (label) label.textContent = duration.label;
  });

  const today = new Date(now);
  const dateKey = `${today.getFullYear()}-${today.getMonth()}-${today.getDate()}`;
  if (dateKey !== state.liveDateKey) {
    state.liveDateKey = dateKey;
    setTodayLabel();
    renderSummary(now);
  }
}

function setSegmented(control, value, dataAttribute) {
  $$(`button[${dataAttribute}]`, control).forEach((button) => {
    button.classList.toggle("active", button.getAttribute(dataAttribute) === value);
  });
}

function toggleMode(mode) {
  $("#mode").value = mode;
  setSegmented($("#mode-control"), mode, "data-mode");
  $("#date-label").textContent = mode === "countdown" ? "目标日期" : "开始日期";
  $("#lunar-date-label").textContent = mode === "countdown" ? "目标农历日期" : "开始农历日期";
  $$(".countdown-only").forEach((element) => element.classList.toggle("is-hidden", mode !== "countdown"));
  if (mode !== "countdown") toggleRepeatRule("once");
}

function toggleRepeatRule(rule) {
  const repeatRule = ["once", "yearly", "monthly", "daily"].includes(rule) ? rule : "once";
  $("#repeat-rule").value = repeatRule;
  setSegmented($("#repeat-rule-control"), repeatRule, "data-repeat-rule");
}

function populateLunarYears(selectedYear = new Date().getFullYear()) {
  const target = $("#lunar-year");
  if (!target.options.length) {
    target.innerHTML = Array.from({ length: 200 }, (_, index) => {
      const year = 1900 + index;
      return `<option value="${year}">${year}年</option>`;
    }).join("");
  }
  target.value = String(selectedYear);
}

function lunarMonthKey(month, isLeap) {
  return `${month}:${isLeap ? 1 : 0}`;
}

function selectedLunarMonth() {
  return state.lunarMonths.find((month) => lunarMonthKey(month.month, month.is_leap) === $("#lunar-month").value);
}

function updateLunarPreview() {
  const month = selectedLunarMonth();
  const day = Number($("#lunar-day").value);
  const preview = $("#lunar-solar-preview");
  if (!month || !day) {
    preview.textContent = "";
    return;
  }
  const solarDate = localDate(month.solar_start);
  solarDate.setDate(solarDate.getDate() + day - 1);
  $("#event-date").value = dateValue(solarDate);
  preview.textContent = `对应公历 ${solarPreviewFormatter.format(solarDate)}`;
}

function renderLunarDays(selectedDay = 1) {
  const month = selectedLunarMonth();
  const target = $("#lunar-day");
  const days = month?.days ?? 29;
  target.innerHTML = Array.from({ length: days }, (_, index) => {
    const day = index + 1;
    return `<option value="${day}">${lunarDayLabel(day)}</option>`;
  }).join("");
  target.value = String(Math.min(Math.max(Number(selectedDay) || 1, 1), days));
  updateLunarPreview();
}

function renderLunarMonths(selection = null) {
  const target = $("#lunar-month");
  target.innerHTML = state.lunarMonths.map((month) => (
    `<option value="${lunarMonthKey(month.month, month.is_leap)}">${escapeHtml(month.label)}</option>`
  )).join("");
  const selectedKey = selection
    ? lunarMonthKey(selection.month, selection.isLeap ?? selection.is_leap)
    : lunarMonthKey(state.lunarMonths[0]?.month, state.lunarMonths[0]?.is_leap);
  if ($(`option[value="${selectedKey}"]`, target)) target.value = selectedKey;
  renderLunarDays(selection?.day ?? 1);
}

function setLunarLoading(loading) {
  const isLunar = $("#calendar-type").value === "lunar";
  $$("select", $("#lunar-date-fields")).forEach((select) => { select.disabled = loading || !isLunar; });
  $("#lunar-date-fields").classList.toggle("is-loading", loading);
  const saveButton = $(".dialog-actions .primary-button");
  if (loading) {
    saveButton.dataset.lunarLoading = "true";
    saveButton.disabled = true;
  } else if (saveButton.dataset.lunarLoading) {
    delete saveButton.dataset.lunarLoading;
    saveButton.disabled = false;
  }
}

async function loadLunarOptions({ year = null, selection = null, solarDate = "" } = {}) {
  const requestId = ++state.lunarOptionsRequest;
  setLunarLoading(true);
  $("#lunar-solar-preview").textContent = "正在换算";
  const params = new URLSearchParams();
  if (solarDate) params.set("solar_date", solarDate);
  else params.set("year", String(year || selection?.year || new Date().getFullYear()));
  try {
    const data = await request(`/api/lunar/options?${params}`);
    if (requestId !== state.lunarOptionsRequest || $("#calendar-type").value !== "lunar") return;
    const resolvedSelection = selection || data.selected || { year: data.year, month: 1, day: 1, is_leap: false };
    state.lunarMonths = data.months;
    populateLunarYears(resolvedSelection.year || data.year);
    renderLunarMonths(resolvedSelection);
  } catch (error) {
    if (requestId === state.lunarOptionsRequest) {
      $("#lunar-solar-preview").textContent = "农历日期加载失败";
      showToast(error.message, true);
    }
  } finally {
    if (requestId === state.lunarOptionsRequest && $("#calendar-type").value === "lunar") {
      setLunarLoading(false);
    }
  }
}

function toggleCalendarType(type, selection = null) {
  const calendarType = type === "lunar" ? "lunar" : "solar";
  $("#calendar-type").value = calendarType;
  setSegmented($("#calendar-type-control"), calendarType, "data-calendar-type");
  const isLunar = calendarType === "lunar";
  $("#solar-date-fields").classList.toggle("is-hidden", isLunar);
  $("#lunar-date-fields").classList.toggle("is-hidden", !isLunar);
  $("#event-date").disabled = isLunar;
  $$("select", $("#lunar-date-fields")).forEach((select) => { select.disabled = !isLunar; });
  if (!isLunar) {
    state.lunarOptionsRequest += 1;
    setLunarLoading(false);
    return;
  }
  populateLunarYears(selection?.year || new Date().getFullYear());
  loadLunarOptions(selection ? { year: selection.year, selection } : { solarDate: $("#event-date").value });
}

function toggleReminderType(type) {
  $("#reminder-type").value = type;
  setSegmented($("#reminder-type-control"), type, "data-reminder-type");
  $(".max-reminders-field").classList.toggle("is-hidden", type !== "times");
}

function toggleReminderFields() {
  $(".reminder-section").classList.toggle("is-disabled", !$("#reminder-enabled").checked);
}

function setColor(color) {
  $("#accent").value = color;
  $$(".color-option").forEach((button) => button.classList.toggle("active", button.dataset.color === color));
}

function resetForm(item = null) {
  form.reset();
  $("#editing-id").value = item?.id ?? "";
  $("#dialog-title").textContent = item ? "编辑纪念日" : "新建纪念日";
  $("#delete-button").classList.toggle("is-hidden", !item);
  $("#test-webhook-button").classList.toggle("is-hidden", !item);
  $("#title").value = item?.title ?? "";
  $("#event-date").value = item?.event_date ?? todayDateValue();
  const [eventHour, eventMinute, eventSecond] = (item?.event_time ?? "00:00:00").split(":");
  $("#event-hour").value = String(Number(eventHour));
  $("#event-minute").value = String(Number(eventMinute));
  $("#event-second").value = String(Number(eventSecond));
  $("#advance-days").value = item?.advance_days ?? 7;
  $("#reminder-time").value = item?.reminder_time ?? "09:00";
  $("#max-reminders").value = item?.max_reminders ?? 3;
  $("#webhook-url").value = item?.webhook_url ?? "";
  $("#web-push-enabled").checked = item ? item.web_push_enabled : true;
  $("#note").value = item?.note ?? "";
  $("#reminder-enabled").checked = item ? item.reminder_enabled : true;
  toggleMode(item?.mode ?? "countdown");
  toggleRepeatRule(item?.mode === "elapsed" ? "once" : (item?.repeat_rule ?? "once"));
  const calendarType = item?.calendar_type ?? "solar";
  const lunarSelection = calendarType === "lunar" ? {
    year: item.lunar_year,
    month: item.lunar_month,
    day: item.lunar_day,
    isLeap: item.lunar_is_leap,
  } : null;
  toggleCalendarType(calendarType, lunarSelection);
  toggleReminderType(item?.reminder_type ?? "daily");
  toggleReminderFields();
  setColor(item?.accent ?? "#EF6E5B");
}

function openDialog(id = null) {
  const item = id === null ? null : state.items.find((entry) => entry.id === id);
  resetForm(item);
  dialog.showModal();
  setTimeout(() => $("#title").focus(), 0);
}

function closeDialog() { dialog.close(); }

function formPayload() {
  const eventTime = ["#event-hour", "#event-minute", "#event-second"]
    .map((selector) => String(Number($(selector).value)).padStart(2, "0"))
    .join(":");
  const calendarType = $("#calendar-type").value;
  const lunarMonth = selectedLunarMonth();
  if (calendarType === "lunar" && !lunarMonth) throw new Error("请选择完整的农历日期");
  return {
    title: $("#title").value,
    accent: $("#accent").value,
    mode: $("#mode").value,
    event_date: $("#event-date").value,
    event_time: eventTime,
    repeat_rule: $("#mode").value === "countdown" ? $("#repeat-rule").value : "once",
    calendar_type: calendarType,
    lunar_year: calendarType === "lunar" ? Number($("#lunar-year").value) : null,
    lunar_month: calendarType === "lunar" ? lunarMonth.month : null,
    lunar_day: calendarType === "lunar" ? Number($("#lunar-day").value) : null,
    lunar_is_leap: calendarType === "lunar" ? lunarMonth.is_leap : false,
    reminder_enabled: $("#reminder-enabled").checked,
    advance_days: $("#advance-days").value,
    reminder_type: $("#reminder-type").value,
    max_reminders: $("#max-reminders").value,
    reminder_time: $("#reminder-time").value,
    webhook_url: $("#webhook-url").value,
    web_push_enabled: $("#web-push-enabled").checked,
    note: $("#note").value,
  };
}

async function request(url, options = {}) {
  const { skipAuth = false, ...fetchOptions } = options;
  const headers = { ...(fetchOptions.headers || {}) };
  if (fetchOptions.body) headers["Content-Type"] = "application/json";
  if (!skipAuth && state.token) headers.Authorization = `Bearer ${state.token}`;
  const response = await fetch(url, {
    ...fetchOptions,
    headers,
  });
  const responseText = response.status === 204 ? "" : await response.text();
  let data = {};
  if (responseText) {
    try {
      data = JSON.parse(responseText);
    } catch (error) {
      data = {};
    }
  }
  if (response.status === 401 && !skipAuth) {
    clearSession();
    showLogin();
  }
  if (!response.ok) {
    const plainText = responseText && !responseText.trim().startsWith("<") ? responseText.trim().slice(0, 180) : "";
    const requestError = new Error(data.error || data.message || plainText || `请求失败（HTTP ${response.status}）`);
    requestError.status = response.status;
    throw requestError;
  }
  return data;
}

function showLogin() {
  state.items = [];
  state.filter = "all";
  state.user = null;
  $$("[data-filter]").forEach((button) => button.classList.toggle("active", button.dataset.filter === "all"));
  render();
  if (dialog.open) dialog.close();
  $("#current-username").textContent = "-";
  $("#app-shell").classList.add("auth-hidden");
  $("#login-screen").classList.remove("is-hidden");
  resetPullIndicator();
  setTimeout(() => $("#username").focus(), 0);
}

function showApp() {
  $("#current-username").textContent = state.user.username;
  $("#login-screen").classList.add("is-hidden");
  $("#app-shell").classList.remove("auth-hidden");
}

function saveSession(token, user) {
  state.token = token;
  state.user = user;
  localStorage.setItem(TOKEN_STORAGE_KEY, token);
}

function clearSession() {
  state.token = "";
  state.user = null;
  state.vapidPublicKey = "";
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

function pushIsSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function isIOSDevice() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isStandaloneApp() {
  return window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
}

function applicationServerKey(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((character) => character.charCodeAt(0)));
}

async function registerServiceWorker() {
  if (!pushIsSupported()) {
    updatePushButton();
    return;
  }
  try {
    state.serviceWorkerRegistration = await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
    try {
      await state.serviceWorkerRegistration.update();
    } catch (updateError) {
      // Keep the active worker when an update check is temporarily unavailable.
    }
    await navigator.serviceWorker.ready;
  } catch (error) {
    state.serviceWorkerRegistration = null;
  }
  updatePushButton();
}

function updatePushButton() {
  const button = $("#notification-button");
  const label = $("#notification-label");
  const disableButton = $("#disable-notification-button");
  const active = Boolean(state.pushSubscription);
  button.classList.toggle("is-active", active);
  button.setAttribute("aria-pressed", String(active));
  disableButton.classList.toggle("is-hidden", !active);

  if (!pushIsSupported()) {
    label.textContent = "此浏览器不支持通知";
    button.disabled = true;
  } else if (Notification.permission === "denied") {
    label.textContent = "通知已被禁用";
    button.disabled = false;
  } else if (active) {
    label.textContent = "发送测试通知";
    button.disabled = false;
  } else {
    label.textContent = "开启系统通知";
    button.disabled = false;
  }
}

async function refreshPushState() {
  if (!state.user || !state.serviceWorkerRegistration || !pushIsSupported()) {
    state.pushSubscription = null;
    updatePushButton();
    return;
  }
  try {
    state.pushSubscription = await state.serviceWorkerRegistration.pushManager.getSubscription();
    if (!state.vapidPublicKey) {
      const session = await request("/api/auth/me");
      state.vapidPublicKey = session.push_public_key || "";
    }
    if (state.pushSubscription) {
      await request("/api/anniversaries/push-subscription", {
        method: "POST",
        body: JSON.stringify({ subscription: state.pushSubscription.toJSON() }),
      });
    }
  } catch (error) {
    state.pushSubscription = null;
  }
  updatePushButton();
}

function pushErrorMessage(stage, error) {
  const name = error?.name && error.name !== "Error" ? error.name : "";
  const message = error?.message || "未知错误";
  if (name === "AbortError" || message.includes("操作未完成")) {
    return `${stage}失败（${name || "AbortError"}：${message}）。请完全关闭纪念簿后重开再试，并确认 iOS 已允许通知。`;
  }
  return `${stage}失败${name ? `（${name}）` : ""}：${message}`;
}

async function createPushSubscription(publicKey) {
  const options = {
    userVisibleOnly: true,
    applicationServerKey: applicationServerKey(publicKey),
  };
  try {
    return await state.serviceWorkerRegistration.pushManager.subscribe(options);
  } catch (error) {
    if (error?.name !== "AbortError" && !String(error?.message || "").includes("操作未完成")) throw error;
    try {
      await state.serviceWorkerRegistration.update();
    } catch (updateError) {
      // The active worker can still subscribe when an update check is unavailable.
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
    state.serviceWorkerRegistration = await navigator.serviceWorker.ready;
    return state.serviceWorkerRegistration.pushManager.subscribe(options);
  }
}

async function enablePushNotifications() {
  if (!window.isSecureContext) {
    showToast("系统通知需要通过 HTTPS 访问页面", true);
    return;
  }
  if (!pushIsSupported() || !state.serviceWorkerRegistration) {
    showToast("当前浏览器不支持 Web Push", true);
    return;
  }
  if (isIOSDevice() && !isStandaloneApp()) {
    showToast("请先用 Safari 将页面添加到主屏幕，再从桌面图标进入", true);
    return;
  }
  if (Notification.permission === "denied") {
    showToast("请在系统设置中允许纪念簿发送通知", true);
    return;
  }

  let stage = "申请通知权限";
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      updatePushButton();
      showToast("未获得系统通知权限", true);
      return;
    }
    stage = "读取推送配置";
    if (!state.vapidPublicKey) {
      const session = await request("/api/auth/me");
      state.vapidPublicKey = session.push_public_key || "";
    }
    if (!state.vapidPublicKey) throw new Error("服务端没有返回 VAPID 公钥");

    stage = "创建设备订阅";
    let subscription = await state.serviceWorkerRegistration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await createPushSubscription(state.vapidPublicKey);
    }
    stage = "保存设备订阅";
    await request("/api/anniversaries/push-subscription", {
      method: "POST",
      body: JSON.stringify({ subscription: subscription.toJSON() }),
    });
    state.pushSubscription = subscription;
    updatePushButton();
    showToast("系统通知已开启，正在发送测试消息");
    await testPushNotification(true);
  } catch (error) {
    showToast(pushErrorMessage(stage, error), true, 5600);
  }
}

async function testPushNotification(fromSetup = false) {
  try {
    const result = await request("/api/anniversaries/push-test", { method: "POST" });
    showToast(result.message || "测试通知已发送");
  } catch (error) {
    const prefix = fromSetup ? "通知订阅已保存，但测试消息发送失败：" : "测试通知发送失败：";
    showToast(`${prefix}${error.message}`, true, 5000);
  }
}

async function handlePushButton() {
  if (state.pushSubscription) await testPushNotification();
  else await enablePushNotifications();
}

async function disablePushNotifications() {
  if (!state.pushSubscription) return;
  const endpoint = state.pushSubscription.endpoint;
  try {
    await request("/api/anniversaries/push-subscription", {
      method: "DELETE",
      body: JSON.stringify({ endpoint }),
    });
    await state.pushSubscription.unsubscribe();
    state.pushSubscription = null;
    updatePushButton();
    showToast("系统通知已关闭");
  } catch (error) {
    showToast(`关闭通知失败：${error.message}`, true);
  }
}

async function restoreSession() {
  if (!state.token) {
    showLogin();
    return;
  }
  try {
    const data = await request("/api/auth/me");
    state.user = data.user;
    state.vapidPublicKey = data.push_public_key || "";
    showApp();
    await Promise.all([loadItems(), refreshPushState()]);
  } catch (error) {
    showLogin();
  }
}

async function login(event) {
  event.preventDefault();
  const button = $("#login-button");
  button.disabled = true;
  button.textContent = "正在进入";
  try {
    const data = await request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: $("#username").value }),
      skipAuth: true,
    });
    saveSession(data.token, data.user);
    state.vapidPublicKey = data.push_public_key || "";
    showApp();
    await Promise.all([loadItems(), refreshPushState()]);
    showToast(data.created ? "已为你创建独立空间" : `欢迎回来，${data.user.username}`);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
    button.innerHTML = "进入纪念簿 <span>→</span>";
  }
}

async function logout() {
  try {
    if (state.token) await request("/api/auth/logout", { method: "POST" });
  } catch (error) {
    // Local session is cleared even if the server was restarted.
  }
  clearSession();
  loginForm.reset();
  showLogin();
}

async function loadItems() {
  try {
    const data = await request("/api/anniversaries");
    state.items = data.items;
    render();
  } catch (error) {
    showToast(`无法读取本地数据：${error.message}`, true);
  }
}

async function saveForm(event) {
  event.preventDefault();
  const saveButton = $(".dialog-actions .primary-button");
  if (saveButton.dataset.lunarLoading) {
    showToast("正在换算农历日期，请稍候");
    return;
  }
  const id = $("#editing-id").value;
  saveButton.disabled = true;
  saveButton.textContent = "正在保存";
  try {
    await request(id ? `/api/anniversaries/${id}` : "/api/anniversaries", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(formPayload()),
    });
    closeDialog();
    await loadItems();
    showToast(id ? "纪念日已更新" : "纪念日已加入清单");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = "保存纪念日";
  }
}

async function deleteAnniversaryById(id, closeEditor = false) {
  if (!id || !window.confirm("删除后无法恢复，确定要删除这个纪念日吗？")) return false;
  try {
    await request(`/api/anniversaries/${id}`, { method: "DELETE" });
    if (closeEditor) closeDialog();
    await loadItems();
    showToast("纪念日已删除");
    return true;
  } catch (error) {
    showToast(`删除失败：${error.message}`, true, 4800);
    return false;
  }
}

async function deleteCurrent() {
  const id = Number($("#editing-id").value);
  await deleteAnniversaryById(id, true);
}

async function testWebhook() {
  const id = $("#editing-id").value;
  if (!id) {
    showToast("请先保存纪念日，再测试机器人", true);
    return;
  }
  const testButton = $("#test-webhook-button");
  testButton.disabled = true;
  testButton.textContent = "正在发送";
  try {
    const result = await request(`/api/anniversaries/${id}/test-webhook`, { method: "POST" });
    showToast(result.message || "测试消息已发送");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    testButton.disabled = false;
    testButton.textContent = "测试机器人";
  }
}

function resetPullIndicator() {
  const indicator = $("#pull-refresh");
  state.pullTracking = false;
  state.pullDistance = 0;
  indicator.classList.remove("is-visible", "is-ready", "is-refreshing");
  indicator.style.transform = "";
  $("#pull-refresh-label").textContent = "下拉刷新";
}

function startPullRefresh(event) {
  if (!state.user || state.pullRefreshing || dialog.open || window.scrollY > 0 || event.touches.length !== 1) return;
  if (event.target.closest("input, textarea, button, a, label")) return;
  state.pullStartY = event.touches[0].clientY;
  state.pullStartX = event.touches[0].clientX;
  state.pullDistance = 0;
  state.pullTracking = true;
}

function movePullRefresh(event) {
  if (!state.pullTracking || event.touches.length !== 1) return;
  const deltaY = event.touches[0].clientY - state.pullStartY;
  const deltaX = Math.abs(event.touches[0].clientX - state.pullStartX);
  if (deltaY <= 0 || deltaY <= deltaX) {
    resetPullIndicator();
    return;
  }
  if (event.cancelable) event.preventDefault();
  state.pullDistance = Math.min(96, deltaY * 0.48);
  const indicator = $("#pull-refresh");
  const ready = state.pullDistance >= 64;
  indicator.classList.add("is-visible");
  indicator.classList.toggle("is-ready", ready);
  indicator.style.transform = `translate(-50%, ${state.pullDistance - 58}px)`;
  $("#pull-refresh-label").textContent = ready ? "松开刷新" : "下拉刷新";
}

async function runPullRefresh() {
  state.pullTracking = false;
  state.pullRefreshing = true;
  const indicator = $("#pull-refresh");
  indicator.classList.remove("is-ready");
  indicator.classList.add("is-visible", "is-refreshing");
  $("#pull-refresh-label").textContent = "正在刷新";
  try {
    const data = await request("/api/anniversaries");
    state.items = data.items;
    render();
    await refreshPushState();
    showToast("数据已刷新");
  } catch (error) {
    showToast(`刷新失败：${error.message}`, true, 4200);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 360));
    state.pullRefreshing = false;
    resetPullIndicator();
  }
}

function finishPullRefresh() {
  if (!state.pullTracking) return;
  if (state.pullDistance >= 64) runPullRefresh();
  else resetPullIndicator();
}

function preventPinchZoom(event) {
  if ((event.touches && event.touches.length > 1) || event.type.startsWith("gesture")) {
    if (event.cancelable) event.preventDefault();
  }
}

function showToast(message, isError = false, duration = 2600) {
  const toast = $("#toast");
  clearTimeout(state.toastTimer);
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.add("show");
  state.toastTimer = setTimeout(() => toast.classList.remove("show"), duration);
}

$("#create-button").addEventListener("click", () => openDialog());
$("#notification-button").addEventListener("click", handlePushButton);
$("#disable-notification-button").addEventListener("click", disablePushNotifications);
loginForm.addEventListener("submit", login);
$("#logout-button").addEventListener("click", logout);
$("#close-dialog").addEventListener("click", closeDialog);
$("#cancel-button").addEventListener("click", closeDialog);
$("#delete-button").addEventListener("click", deleteCurrent);
$("#test-webhook-button").addEventListener("click", testWebhook);
form.addEventListener("submit", saveForm);
$("#mode-control").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-mode]");
  if (button) toggleMode(button.dataset.mode);
});
$("#repeat-rule-control").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-repeat-rule]");
  if (button) toggleRepeatRule(button.dataset.repeatRule);
});
$("#calendar-type-control").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-calendar-type]");
  if (button) toggleCalendarType(button.dataset.calendarType);
});
$("#lunar-year").addEventListener("change", () => {
  loadLunarOptions({ year: Number($("#lunar-year").value) });
});
$("#lunar-month").addEventListener("change", () => {
  renderLunarDays(Number($("#lunar-day").value) || 1);
});
$("#lunar-day").addEventListener("change", updateLunarPreview);
$("#reminder-type-control").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-reminder-type]");
  if (button) toggleReminderType(button.dataset.reminderType);
});
$("#color-options").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-color]");
  if (button) setColor(button.dataset.color);
});
$("#reminder-enabled").addEventListener("change", toggleReminderFields);
document.addEventListener("touchstart", startPullRefresh, { passive: true });
document.addEventListener("touchmove", movePullRefresh, { passive: false });
document.addEventListener("touchmove", preventPinchZoom, { passive: false });
document.addEventListener("touchend", finishPullRefresh, { passive: true });
document.addEventListener("touchcancel", resetPullIndicator, { passive: true });
document.addEventListener("gesturestart", preventPinchZoom, { passive: false });
document.addEventListener("gesturechange", preventPinchZoom, { passive: false });
document.addEventListener("gestureend", preventPinchZoom, { passive: false });
document.addEventListener("pointerdown", (event) => {
  if (state.openSwipeId === null || event.target.closest(".anniversary-swipe")) return;
  closeOpenSwipe();
});
$$("[data-filter]").forEach((button) => button.addEventListener("click", () => {
  state.filter = button.dataset.filter;
  $$('[data-filter]').forEach((entry) => entry.classList.toggle("active", entry === button));
  renderList();
}));

async function initialize() {
  updateVisualViewportHeight();
  setTodayLabel();
  $("#login-calendar-day").textContent = new Date().getDate();
  await registerServiceWorker();
  await restoreSession();
  updateLiveDurations();
  window.setInterval(updateLiveDurations, 1000);
}

function updateVisualViewportHeight() {
  const height = window.visualViewport?.height || window.innerHeight;
  document.documentElement.style.setProperty("--visual-viewport-height", `${Math.round(height)}px`);
}

window.addEventListener("resize", updateVisualViewportHeight);
window.visualViewport?.addEventListener("resize", updateVisualViewportHeight);
window.visualViewport?.addEventListener("scroll", updateVisualViewportHeight);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) updateLiveDurations();
});
initialize();
