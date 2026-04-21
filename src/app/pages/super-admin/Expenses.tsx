import { useState } from "react";
import { Plus, Search, Upload } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import ExportButton from "../../components/ExportButton";

const expenses = [
  { id: 1, category: "Office Supplies", amount: 15000, date: "2026-04-15", description: "Stationery and printing" },
  { id: 2, category: "Utilities", amount: 25000, date: "2026-04-14", description: "Electricity bill" },
  { id: 3, category: "Transportation", amount: 8500, date: "2026-04-13", description: "Fuel and maintenance" },
  { id: 4, category: "Miscellaneous", amount: 12500, date: "2026-04-12", description: "Client meeting expenses" },
];

const initialCategories = ["Office Supplies", "Utilities", "Transportation", "Miscellaneous", "Equipment", "Marketing"];

export default function Expenses() {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isViewModalOpen, setIsViewModalOpen] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [selectedExpense, setSelectedExpense] = useState<any>(null);
  
  const [categories, setCategories] = useState(initialCategories);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("All Categories");

  const [isCatModalOpen, setIsCatModalOpen] = useState(false);
  const [catAction, setCatAction] = useState<"add" | "edit">("add");
  const [currentCat, setCurrentCat] = useState("");
  const [catInput, setCatInput] = useState("");

  const filteredExpenses = expenses.filter(exp => {
    const matchSearch = exp.description.toLowerCase().includes(searchQuery.toLowerCase()) || exp.category.toLowerCase().includes(searchQuery.toLowerCase());
    const matchCat = selectedCategory === "All Categories" || exp.category === selectedCategory;
    return matchSearch && matchCat;
  });

  const handleSaveCategory = () => {
    if (!catInput.trim()) return;
    if (catAction === "add") {
       setCategories([...categories, catInput]);
    } else {
       setCategories(categories.map(c => c === currentCat ? catInput : c));
    }
    setIsCatModalOpen(false);
  };

  const viewExpense = (expense: any) => {
    setSelectedExpense(expense);
    setIsViewModalOpen(true);
  };

  const editExpense = (expense: any) => {
    setSelectedExpense(expense);
    setIsEditModalOpen(true);
  };

  return (
    <>
      <Header
        title="Expenses"
        actions={
          <>
            <ExportButton onExport={() => console.log("Export")} />
            <Button variant="primary" size="md" onClick={() => setIsModalOpen(true)}>
              <Plus className="w-4 h-4 mr-2" strokeWidth={1.5} />
              Add Expense
            </Button>
          </>
        }
      />

      <div className="flex-1 overflow-y-auto p-8">
        <div className="bg-white rounded-lg border border-slate-200 mb-6">
          <div className="p-6 border-b border-slate-200">
            <div className="flex items-center gap-4">
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" strokeWidth={1.5} />
                <input
                  type="text"
                  placeholder="Search expenses..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                />
              </div>
              <select 
                value={selectedCategory} 
                onChange={e => setSelectedCategory(e.target.value)}
                className="px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              >
                <option>All Categories</option>
                {categories.map((cat) => (
                  <option key={cat}>{cat}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Category</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Description</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Amount</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Date</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {filteredExpenses.map((expense) => (
                  <tr key={expense.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-6 py-4 text-sm text-slate-900">{expense.category}</td>
                    <td className="px-6 py-4 text-sm text-slate-600">{expense.description}</td>
                    <td className="px-6 py-4 text-sm text-slate-900">PKR {expense.amount.toLocaleString()}</td>
                    <td className="px-6 py-4 text-sm text-slate-600">{expense.date}</td>
                    <td className="px-6 py-4 flex gap-2">
                      <Button variant="ghost" size="sm" onClick={() => viewExpense(expense)}>
                        View
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => editExpense(expense)}>
                        Edit
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="bg-white rounded-lg border border-slate-200 p-6">
          <h3 className="text-base mb-6 text-slate-900">Category Management</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {categories.map((category) => (
              <div key={category} className="p-4 border border-slate-200 rounded-lg flex items-center justify-between">
                <span className="text-sm text-slate-900">{category}</span>
                <Button variant="ghost" size="sm" onClick={() => { setCatAction("edit"); setCurrentCat(category); setCatInput(category); setIsCatModalOpen(true); }}>
                  Edit
                </Button>
              </div>
            ))}
            <button 
              onClick={() => { setCatAction("add"); setCatInput(""); setIsCatModalOpen(true); }}
              className="p-4 border border-dashed border-slate-300 rounded-lg text-sm text-slate-500 hover:border-slate-400 hover:text-slate-700 transition-colors"
            >
              + Add Category
            </button>
          </div>
        </div>
      </div>

      <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title="Add Expense" size="md">
        <form className="space-y-4">
          <div>
            <label className="block text-sm text-slate-700 mb-1">Category</label>
            <select className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent">
              <option>Select category</option>
              {categories.map((cat) => (
                <option key={cat}>{cat}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Amount (PKR)</label>
            <input
              type="number"
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              placeholder="Enter amount"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Date</label>
            <input
              type="date"
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Description</label>
            <textarea
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              rows={3}
              placeholder="Enter description"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Receipt</label>
            <div className="flex items-center gap-3">
              <input
                type="file"
                className="flex-1 px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              />
              <Button variant="secondary" size="md">
                <Upload className="w-4 h-4" strokeWidth={1.5} />
              </Button>
            </div>
          </div>
          <div className="flex items-center gap-3 pt-4">
            <Button variant="primary" size="md" className="flex-1">
              Add Expense
            </Button>
            <Button variant="secondary" size="md" onClick={() => setIsModalOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </Modal>

      <Modal isOpen={isViewModalOpen} onClose={() => setIsViewModalOpen(false)} title="Expense Details" size="md">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-sm text-slate-500 mb-1">Category</p>
              <p className="text-sm text-slate-900">{selectedExpense?.category}</p>
            </div>
            <div>
              <p className="text-sm text-slate-500 mb-1">Amount</p>
              <p className="text-sm text-slate-900">PKR {selectedExpense?.amount.toLocaleString()}</p>
            </div>
            <div>
              <p className="text-sm text-slate-500 mb-1">Date</p>
              <p className="text-sm text-slate-900">{selectedExpense?.date}</p>
            </div>
          </div>
          <div className="pt-4 border-t border-slate-200">
            <p className="text-sm text-slate-500 mb-1">Description</p>
            <p className="text-sm text-slate-900">{selectedExpense?.description}</p>
          </div>
          <div className="pt-4 border-t border-slate-200">
            <p className="text-sm text-slate-500 mb-2">Receipt</p>
            <div className="border border-slate-200 rounded-lg p-4 text-center">
              <p className="text-sm text-slate-500">Receipt preview would appear here</p>
            </div>
          </div>
          <div className="pt-4 border-t border-slate-200">
            <Button variant="secondary" size="md" className="w-full" onClick={() => setIsViewModalOpen(false)}>
              Close
            </Button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={isEditModalOpen} onClose={() => setIsEditModalOpen(false)} title="Edit Expense" size="md">
        <form className="space-y-4">
          <div>
            <label className="block text-sm text-slate-700 mb-1">Category</label>
            <select
              defaultValue={selectedExpense?.category}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
            >
              <option>Select category</option>
              {categories.map((cat) => (
                <option key={cat}>{cat}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Amount (PKR)</label>
            <input
              type="number"
              defaultValue={selectedExpense?.amount}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
              placeholder="Enter amount"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Date</label>
            <input
              type="date"
              defaultValue={selectedExpense?.date}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Description</label>
            <textarea
              defaultValue={selectedExpense?.description}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
              rows={3}
              placeholder="Enter description"
            />
          </div>
          <div className="flex items-center gap-3 pt-4">
            <Button variant="primary" size="md" className="flex-1">
              Update Expense
            </Button>
            <Button variant="secondary" size="md" onClick={() => setIsEditModalOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </Modal>

      <Modal isOpen={isCatModalOpen} onClose={() => setIsCatModalOpen(false)} title={catAction === "add" ? "Add Category" : "Edit Category"} size="sm">
        <div className="space-y-4">
          <div>
            <label className="block text-sm text-slate-700 mb-1">Category Name</label>
            <input
              type="text"
              value={catInput}
              onChange={e => setCatInput(e.target.value)}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
            />
          </div>
          <div className="flex items-center gap-3 pt-4">
            <Button variant="primary" size="md" className="flex-1" onClick={handleSaveCategory}>
              Save
            </Button>
            <Button variant="secondary" size="md" onClick={() => setIsCatModalOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
