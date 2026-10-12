/*
  管理後台的 JavaScript（管理者用）

  這次新增的部分：
  1. 時段管理：新增可預約的時段，並顯示時段清單（看得出有沒有被預約）。
  2. 「一次新增半天」：選「整個上午」或「整個下午」的時候，
     我們把它拆成一個一個時段，依序送給後端。
     後端每一個都會自己檢查（已經存在、離開始不到 1 小時的會被擋下來），
     最後前端再統計「新增幾個、略過幾個」顯示出來。
     這樣做的好處是後端不用多寫新的 API。
  3. 案件表格改成讀 /api/admin/tickets，可以看到完整姓名、電話和預約時段。
  4. 「已取消」的案件不能再改狀態（下拉選單和按鈕都停用）。
*/
const table = document.querySelector("#ticket-table");
const tableBody = table.querySelector("tbody");
const emptyState = document.querySelector("#empty-state");
const message = document.querySelector("#message");
const refreshButton = document.querySelector("#refresh-button");
// 後台可以手動選的狀態。這裡沒有「已取消」，因為它只能由報修的人在前台取消；
// 取消的時候後端還要把時段放出來，如果後台可以直接改，時段就不會被釋放了。
const statuses = ["待處理", "處理中", "已完成"];
const cancelledStatus = "已取消";

// 【新增】時段管理會用到的元素
const slotForm = document.querySelector("#slot-form");
const slotDateInput = document.querySelector("#slot-date");
const slotPeriodSelect = document.querySelector("#slot-period");
const slotTable = document.querySelector("#slot-table");
const slotTableBody = slotTable.querySelector("tbody");
const slotEmptyState = document.querySelector("#slot-empty-state");
const slotMessage = document.querySelector("#slot-message");
const slotRefreshButton = document.querySelector("#slot-refresh-button");

// 【新增】「一次新增半天」的對照表：下拉選單的值 → 要新增哪些開始時間。
// 例如選「整個上午」，就會新增 08:00、09:00、10:00、11:00 四個時段。
// 如果選的不是這兩個（而是像 "09:00" 這種單一時段），就只新增那一個。
const BATCH_PERIODS = {
  morning: ["08:00", "09:00", "10:00", "11:00"],
  afternoon: ["12:00", "13:00", "14:00", "15:00", "16:00", "17:00"],
};

function showMessage(text, isError = false) {
  message.textContent = text;
  message.classList.toggle("error", isError);
}

function showSlotMessage(text, isError = false) {
  slotMessage.textContent = text;
  slotMessage.classList.toggle("error", isError);
}

function addCell(row, value) {
  const cell = document.createElement("td");
  cell.textContent = value;
  row.appendChild(cell);
  return cell;
}

function createStatusSelect(currentStatus) {
  const select = document.createElement("select");
  // 【新增】已取消的案件，選單裡只放「已取消」，而且不能再改
  const options = currentStatus === cancelledStatus ? [cancelledStatus] : statuses;
  select.disabled = currentStatus === cancelledStatus;
  for (const status of options) {
    const option = document.createElement("option");
    option.value = status;
    option.textContent = status;
    option.selected = status === currentStatus;
    select.appendChild(option);
  }
  return select;
}

function renderTickets(tickets) {
  tableBody.replaceChildren();
  emptyState.hidden = tickets.length > 0;
  table.hidden = tickets.length === 0;

  for (const ticket of tickets) {
    const row = document.createElement("tr");
    addCell(row, ticket.id);
    addCell(row, `${ticket.location}／${ticket.equipment}`);
    addCell(row, ticket.slot_label || "—"); // 【新增】預約時段，沒預約就顯示「—」
    addCell(row, ticket.name); // 【修改】原本是聯絡方式，後台顯示完整姓名
    addCell(row, ticket.phone); // 【新增】後台顯示完整電話
    addCell(row, ticket.description);
    addCell(row, ticket.created_at);

    const statusCell = document.createElement("td");
    const select = createStatusSelect(ticket.status);
    statusCell.appendChild(select);
    row.appendChild(statusCell);

    const actionCell = document.createElement("td");
    const saveButton = document.createElement("button");
    saveButton.type = "button";
    saveButton.textContent = "儲存狀態";
    saveButton.disabled = ticket.status === cancelledStatus; // 【新增】已取消的案件不能儲存
    saveButton.addEventListener("click", () => updateStatus(ticket.id, select.value));
    actionCell.appendChild(saveButton);
    row.appendChild(actionCell);
    tableBody.appendChild(row);
  }
}

async function loadTickets() {
  try {
    // 【修改】改成讀後台專用的 API（有完整姓名和電話）。
    // 前台用的 /api/tickets 已經沒有電話了。
    const response = await fetch("/api/admin/tickets");
    if (!response.ok) throw new Error("無法讀取案件清單");
    renderTickets(await response.json());
  } catch (error) {
    showMessage(error.message, true);
  }
}

async function updateStatus(ticketId, status) {
  try {
    const response = await fetch(`/api/tickets/${ticketId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || "更新狀態失敗");
    showMessage(result.message);
    await loadTickets();
  } catch (error) {
    showMessage(error.message, true);
  }
}

// ---------------------------------------------------------------
// 【新增】時段管理
// ---------------------------------------------------------------
function renderSlots(slots) {
  slotTableBody.replaceChildren();
  slotEmptyState.hidden = slots.length > 0;
  slotTable.hidden = slots.length === 0;

  for (const slot of slots) {
    const row = document.createElement("tr");
    addCell(row, slot.label);
    addCell(row, slot.booked ? "已預約" : "可預約");
    addCell(row, slot.ticket_id || "—");
    slotTableBody.appendChild(row);
  }
}

async function loadSlots() {
  try {
    const response = await fetch("/api/admin/slots");
    if (!response.ok) throw new Error("無法讀取時段清單");
    renderSlots(await response.json());
  } catch (error) {
    showSlotMessage(error.message, true);
  }
}

// 新增時段。選的是「單一時段」就只新增一個；
// 選的是「整個上午／整個下午」就一個一個依序新增。
async function createSlot(event) {
  event.preventDefault();

  // 選單一開始是提示文字（值是空的）。瀏覽器的 required 通常就會擋住了，
  // 這裡是多檢查一次，比較保險。
  if (!slotPeriodSelect.value) {
    showSlotMessage("請選擇可開放的預約時段", true);
    return;
  }

  const periods = BATCH_PERIODS[slotPeriodSelect.value] || [slotPeriodSelect.value];
  let created = 0; // 成功新增了幾個
  let skipped = 0; // 被後端拒絕（已存在、離開始不到 1 小時…）而略過幾個
  let lastMessage = ""; // 後端最後回傳的訊息（只新增單一時段時，直接顯示這個）

  try {
    for (const period of periods) {
      const response = await fetch("/api/admin/slots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: slotDateInput.value, period }),
      });
      const result = await response.json();
      lastMessage = result.message || "";
      if (response.ok) {
        created += 1;
      } else {
        skipped += 1; // 不用停下來，後面的時段還是要繼續新增
      }
    }

    if (periods.length === 1) {
      // 只新增單一時段：直接顯示後端的訊息（成功，或失敗的原因）
      showSlotMessage(lastMessage || (created ? "已新增時段" : "新增時段失敗"), created === 0);
    } else if (created === 0) {
      showSlotMessage(`沒有新增任何時段（${skipped} 個都已存在，或距離開始不足 1 小時）`, true);
    } else {
      const skippedText = skipped > 0 ? `，略過 ${skipped} 個（已存在，或距離開始不足 1 小時）` : "";
      showSlotMessage(`已新增 ${created} 個時段${skippedText}`);
    }
    await loadSlots();
  } catch (error) {
    showSlotMessage(error.message, true);
  }
}

// 日期欄位的設定，有兩件事：
// 1. 最早只能選今天（用電腦上的日期，才不會差一天）。這只是方便使用者，
//    真正的日期檢查是在後端 app.py。
// 2. 提示文字要顯示「年/月/日」。如果直接用 type="date"，欄位空白時瀏覽器會自己顯示
//    「yyyy/月/dd」（英文和中文混在一起），而且網頁沒辦法改它。
//    所以平常先讓欄位是一般的文字框（admin.html 裡的 placeholder 就是「年/月/日」），
//    使用者點下去才換成日期選擇器；如果沒選日期就離開，再換回文字框。
function setupDateInput() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  slotDateInput.min = `${now.getFullYear()}-${month}-${day}`;

  slotDateInput.addEventListener("focus", () => {
    slotDateInput.type = "date";
    try {
      slotDateInput.showPicker(); // 直接把日曆打開（有些瀏覽器不支援，就略過）
    } catch (error) {
      /* 不支援也沒關係，使用者還是可以自己輸入，或點日曆的小圖示 */
    }
  });
  slotDateInput.addEventListener("blur", () => {
    if (!slotDateInput.value) slotDateInput.type = "text"; // 沒選日期就離開，換回文字框，才會再顯示「年/月/日」
  });
}

refreshButton.addEventListener("click", loadTickets);
slotRefreshButton.addEventListener("click", loadSlots);
slotForm.addEventListener("submit", createSlot);
setupDateInput();
loadTickets();
loadSlots();