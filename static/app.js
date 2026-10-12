/*
  報修頁面的 JavaScript（報修的人用）

  這次新增的部分：
  1. loadSlots()：跟後端要「還能預約」的時段，放進下拉選單。
  2. 送出報修時多帶一個 slot_id（空字串的意思是「不指定時段」）。
  3. cancelTicket()：報修的人取消案件，要輸入送單時填的電話，由後端檢查對不對。
  4. 案件清單改成顯示「報修人」（後端已經遮蔽過）和「預約時段」，
     還能取消的案件旁邊會有「取消報修」按鈕。
  5. 姓名、電話的防呆檢查，以及送出時不能連點。

  前端只負責顯示畫面和把資料送出去。
  時段有沒有被搶走、電話對不對、能不能取消，這些真正的判斷都在後端 app.py。
*/
const form = document.querySelector("#ticket-form");
const message = document.querySelector("#message");
const table = document.querySelector("#ticket-table");
const tableBody = table.querySelector("tbody");
const emptyState = document.querySelector("#empty-state");
const refreshButton = document.querySelector("#refresh-button");
const slotSelect = document.querySelector("#slot-select"); // 【新增】時段下拉選單
const nameInput = document.querySelector("#name-input"); // 【新增】防呆檢查要用到的欄位
const phoneInput = document.querySelector("#phone-input");
const nameHint = document.querySelector("#name-hint"); // 欄位下方的紅字提示
const phoneHint = document.querySelector("#phone-hint");
const submitButton = document.querySelector("#submit-button");

// ---------------------------------------------------------------
// 【新增】輸入防呆
// 這裡的檢查只是讓使用者打字的時候就知道哪裡錯了，不用等按送出才發現。
// 我們不會擋著不讓使用者打字（想打什麼都可以打），
// 而是在欄位下面顯示紅字提示，而且內容不對的話，按送出會被擋下來。
// 真正的檢查在後端 app.py（兩邊的規則要一樣），因為前端可以被繞過。
// ---------------------------------------------------------------
const NAME_PATTERN = /^\p{L}+(?:[ ·.'-]\p{L}+)*$/u; // 只能是文字，不能有數字和特殊符號
const PHONE_PATTERN = /^[0-9]+(?:[ -][0-9]+)*$/; // 數字，中間可以放一個 - 或空格

const NAME_MESSAGE = "姓名只能輸入文字，不可有數字或特殊符號";
const PHONE_MESSAGE = "電話只能輸入數字，數字之間可用「-」或空格分隔";

// 把提示文字放到欄位下面；沒有提示的時候就把那一行藏起來
function showHint(hintElement, text) {
  hintElement.textContent = text;
  hintElement.hidden = !text;
}

// setCustomValidity 放進一段文字，瀏覽器就會擋住送出，並把這段文字顯示出來；
// 放空字串就代表這個欄位沒問題。
// 紅字提示的時機：
//   - 打字的時候：只有明顯打錯才馬上提示（例如姓名打了數字、電話打了英文字母）。
//     像電話剛打了連字號、還沒打下一個數字，這時候先不吵使用者。
//   - 離開欄位的時候（isLeaving）：不管哪種問題，都會提示。
function checkName(isLeaving = false) {
  const text = nameInput.value.trim();
  const problem = text && !NAME_PATTERN.test(text) ? NAME_MESSAGE : "";
  nameInput.setCustomValidity(problem);

  const clearlyWrong = /[^\p{L} ·.'-]/u.test(text); // 有文字、空格和 · . ' - 以外的字元
  showHint(nameHint, isLeaving || clearlyWrong ? problem : "");
}

function checkPhone(isLeaving = false) {
  const text = phoneInput.value.trim();
  const problem = text && !PHONE_PATTERN.test(text) ? PHONE_MESSAGE : "";
  phoneInput.setCustomValidity(problem);

  const clearlyWrong = /[^0-9 -]/.test(text); // 打了數字、-、空格以外的字元
  showHint(phoneHint, isLeaving || clearlyWrong ? problem : "");
}

nameInput.addEventListener("input", () => checkName(false));
nameInput.addEventListener("blur", () => checkName(true));
phoneInput.addEventListener("input", () => checkPhone(false));
phoneInput.addEventListener("blur", () => checkPhone(true));

function showMessage(text, isError = false) {
  message.textContent = text;
  message.classList.toggle("error", isError);
}

function addCell(row, value) {
  const cell = document.createElement("td");
  cell.textContent = value;
  row.appendChild(cell);
}

function renderTickets(tickets) {
  tableBody.replaceChildren();
  emptyState.hidden = tickets.length > 0;
  table.hidden = tickets.length === 0;

  for (const ticket of tickets) {
    const row = document.createElement("tr");
    addCell(row, ticket.id);
    addCell(row, ticket.location);
    addCell(row, ticket.equipment);
    addCell(row, ticket.urgency);
    addCell(row, ticket.reporter); // 【修改】原本是聯絡方式，現在是後端遮蔽過的姓名
    addCell(row, ticket.slot_label || "—"); // 【新增】預約時段，沒預約就顯示「—」
    addCell(row, ticket.status);
    addCell(row, ticket.description);
    addCell(row, ticket.created_at);

    // 【新增】只有「還能取消」的案件才會有取消按鈕。
    // 還能取消 = 狀態是「待處理」，而且距離預約時段開始至少 1 小時（後端算好 can_cancel 給我們）。
    // 這裡只是讓畫面看起來清楚，就算有人直接送資料給後端，後端也會擋掉。
    const actionCell = document.createElement("td");
    if (ticket.can_cancel) {
      const cancelButton = document.createElement("button");
      cancelButton.type = "button";
      cancelButton.className = "secondary";
      cancelButton.textContent = "取消報修";
      cancelButton.addEventListener("click", () => cancelTicket(ticket.id));
      actionCell.appendChild(cancelButton);
    } else {
      // 如果是「待處理」卻不能取消，代表離預約時段開始不到 1 小時了
      actionCell.textContent = ticket.status === "待處理" ? "已逾取消時限" : "—";
    }
    row.appendChild(actionCell);
    tableBody.appendChild(row);
  }
}

async function loadTickets() {
  try {
    const response = await fetch("/api/tickets"); // 前台用的 API，裡面沒有電話
    if (!response.ok) throw new Error("無法讀取案件清單");
    renderTickets(await response.json());
  } catch (error) {
    showMessage(error.message, true);
  }
}

// 【新增】跟後端要「還能預約」的時段，重新放進下拉選單。
// 選單的第一個選項是 index.html 裡寫好的提示文字「請選擇欲預約的維修時段」，
// 重新放選項的時候要留著它（送出表單、reset 之後，選單才會回到這行提示文字），
// 所以我們只刪掉它後面的選項，再重新加上「不指定時段」和每個時段。
async function loadSlots() {
  try {
    const response = await fetch("/api/slots");
    if (!response.ok) throw new Error("無法讀取可預約時段");
    const slots = await response.json();

    const previous = slotSelect.value; // 先記住使用者原本選了什麼，重新放完再選回去
    while (slotSelect.options.length > 1) {
      slotSelect.remove(1);
    }

    const noneOption = document.createElement("option");
    noneOption.value = "none";
    noneOption.textContent = "不指定時段";
    slotSelect.appendChild(noneOption);

    for (const slot of slots) {
      const option = document.createElement("option");
      option.value = slot.id;
      option.textContent = slot.label;
      slotSelect.appendChild(option);
    }

    // 原本選的如果還在（時段還能預約，或選的是「不指定時段」），就維持原本的選擇；
    // 如果時段已經被別人預約走了，就回到提示文字，請使用者重新選。
    const stillAvailable = previous === "none" || slots.some((slot) => slot.id === previous);
    slotSelect.value = stillAvailable ? previous : "";
  } catch (error) {
    showMessage(error.message, true);
  }
}

// 【新增】報修的人取消案件。
// 我們的系統沒有登入，所以請使用者輸入送單時填的電話，交給後端檢查。
// 結果用 alert 跳出來，因為上面的訊息區離表格很遠，使用者在看表格時不太會注意到。
async function cancelTicket(ticketId) {
  const phone = window.prompt(`要取消 ${ticketId}，請輸入送出報修時填寫的聯絡電話：`);
  if (phone === null) return; // 使用者按了「取消」就什麼都不做

  try {
    const response = await fetch(`/api/tickets/${ticketId}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || "取消失敗");

    window.alert(result.message);
    // 取消之後時段被放出來了，所以案件清單和時段選單都要重新讀一次
    await Promise.all([loadTickets(), loadSlots()]);
  } catch (error) {
    window.alert(error.message);
    await loadTickets();
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  showMessage("正在建立報修單…");

  const formData = new FormData(form);
  // 表單裡的 name、phone、slot_id 等欄位會一起送給後端
  const payload = Object.fromEntries(formData.entries());
  // 選單裡「不指定時段」的值是 none，但後端是用空字串代表「不預約」，所以送出前先換過來
  if (payload.slot_id === "none") payload.slot_id = "";

  // 【新增】送出的時候先把按鈕停用，避免使用者連點，同一張單送出好幾次
  submitButton.disabled = true;
  try {
    const response = await fetch("/api/tickets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json();

    if (!response.ok) throw new Error(result.message || "建立報修單失敗");

    showMessage(result.message);
    form.reset();
    checkName(); // 表單清空了，欄位下面的提示和錯誤狀態也要一起清掉
    checkPhone();
    // 【新增】預約成功之後，那個時段不能再被選，所以時段選單也要重新讀一次
    await Promise.all([loadTickets(), loadSlots()]);
  } catch (error) {
    showMessage(error.message, true);
    // 【新增】失敗的時候（例如時段剛好被別人預約走）也重新讀一次選單，
    // 讓使用者看到現在還能選哪些時段
    await loadSlots();
  } finally {
    submitButton.disabled = false; // 不管成功還是失敗，最後都要把按鈕恢復
  }
});

refreshButton.addEventListener("click", () => {
  loadTickets();
  loadSlots();
});
loadTickets();
loadSlots();