import { useState } from "react";
import { Plus, Shield, Users as UsersIcon, MapPin } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import ExportButton from "../../components/ExportButton";

const weaponsInventory = [
  { id: 1, type: "Glock 17", serialNo: "GL-001-2024", status: "Issued", location: "F-10 Islamabad", issuedTo: "Muhammad Usman", licenseExpiry: "2026-12-15" },
  { id: 2, type: "Glock 17", serialNo: "GL-002-2024", status: "Available", location: "F-10 Islamabad", issuedTo: "-", licenseExpiry: "2026-12-15" },
  { id: 3, type: "Shotgun", serialNo: "SG-001-2024", status: "Issued", location: "F-7 Islamabad", issuedTo: "Ali Raza", licenseExpiry: "2026-11-20" },
  { id: 4, type: "Rifle", serialNo: "RF-001-2024", status: "Maintenance", location: "F-10 Islamabad", issuedTo: "-", licenseExpiry: "2027-01-10" },
];

const uniformsInventory = [
  { id: 1, type: "Security Guard Uniform", size: "L", quantity: 45, location: "F-10 Islamabad", status: "In Stock" },
  { id: 2, type: "Security Guard Uniform", size: "M", quantity: 32, location: "F-10 Islamabad", status: "In Stock" },
  { id: 3, type: "Tactical Vest", size: "L", quantity: 15, location: "F-7 Islamabad", status: "Low Stock" },
  { id: 4, type: "Boots", size: "42", quantity: 8, location: "F-10 Islamabad", status: "Low Stock" },
];

const issuanceRecords = [
  { id: 1, employee: "Muhammad Usman", item: "Glock 17 (GL-001-2024)", type: "Weapon", location: "F-10 Islamabad", issuedDate: "2026-01-15", returnDate: "-" },
  { id: 2, employee: "Ayesha Malik", item: "Security Guard Uniform (L)", type: "Uniform", location: "F-10 Islamabad", issuedDate: "2026-02-01", returnDate: "-" },
  { id: 3, employee: "Ali Raza", item: "Shotgun (SG-001-2024)", type: "Weapon", location: "F-7 Islamabad", issuedDate: "2026-01-20", returnDate: "-" },
  { id: 4, employee: "Bilal Ahmed", item: "Tactical Vest (L)", type: "Uniform", location: "F-7 Islamabad", issuedDate: "2026-03-10", returnDate: "-" },
];

export default function Inventory() {
  const [activeTab, setActiveTab] = useState<"weapons" | "uniforms" | "issuance">("weapons");
  const [isIssueModalOpen, setIsIssueModalOpen] = useState(false);
  const [isWeaponDetailsModalOpen, setIsWeaponDetailsModalOpen] = useState(false);
  const [isUniformStockModalOpen, setIsUniformStockModalOpen] = useState(false);
  const [isReturnModalOpen, setIsReturnModalOpen] = useState(false);
  const [selectedWeapon, setSelectedWeapon] = useState<any>(null);
  const [selectedUniform, setSelectedUniform] = useState<any>(null);
  const [selectedIssuance, setSelectedIssuance] = useState<any>(null);

  const viewWeaponDetails = (weapon: any) => {
    setSelectedWeapon(weapon);
    setIsWeaponDetailsModalOpen(true);
  };

  const manageUniformStock = (uniform: any) => {
    setSelectedUniform(uniform);
    setIsUniformStockModalOpen(true);
  };

  const markReturned = (issuance: any) => {
    setSelectedIssuance(issuance);
    setIsReturnModalOpen(true);
  };

  return (
    <>
      <Header
        title="Inventory & Asset Logistics"
        actions={
          <>
            <ExportButton onExport={() => console.log("Export")} />
            <Button variant="primary" size="md" onClick={() => setIsIssueModalOpen(true)}>
              <Plus className="w-4 h-4 mr-2" strokeWidth={1.5} />
              Issue Item
            </Button>
          </>
        }
      />

      <div className="flex-1 overflow-y-auto p-8">
        <div className="bg-white rounded-lg border border-slate-200">
          <div className="p-6 border-b border-slate-200">
            <div className="flex gap-2">
              {([
                { key: "weapons", label: "Weapons Inventory" },
                { key: "uniforms", label: "Uniforms & Gear" },
                { key: "issuance", label: "Issuance Tracking" },
              ] as const).map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={`px-4 py-2 rounded-md text-sm transition-colors ${
                    activeTab === tab.key
                      ? "bg-blue-600 text-white"
                      : "text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {activeTab === "weapons" && (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Type</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Serial Number</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Status</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Location</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Issued To</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">License Expiry</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {weaponsInventory.map((weapon) => (
                    <tr key={weapon.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          <Shield className="w-4 h-4 text-red-600" strokeWidth={1.5} />
                          <span className="text-sm text-slate-900">{weapon.type}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-sm text-slate-600">{weapon.serialNo}</td>
                      <td className="px-6 py-4">
                        <span
                          className={`inline-flex items-center px-2.5 py-0.5 rounded text-xs ${
                            weapon.status === "Issued"
                              ? "bg-blue-50 text-blue-700"
                              : weapon.status === "Available"
                              ? "bg-green-50 text-green-700"
                              : "bg-amber-50 text-amber-700"
                          }`}
                        >
                          {weapon.status}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-sm text-slate-600">{weapon.location}</td>
                      <td className="px-6 py-4 text-sm text-slate-900">{weapon.issuedTo}</td>
                      <td className="px-6 py-4 text-sm text-slate-600">{weapon.licenseExpiry}</td>
                      <td className="px-6 py-4">
                        <Button variant="ghost" size="sm" onClick={() => viewWeaponDetails(weapon)}>
                          View Details
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {activeTab === "uniforms" && (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Item Type</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Size</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Quantity</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Location</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Status</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {uniformsInventory.map((uniform) => (
                    <tr key={uniform.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          <UsersIcon className="w-4 h-4 text-blue-600" strokeWidth={1.5} />
                          <span className="text-sm text-slate-900">{uniform.type}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-sm text-slate-600">{uniform.size}</td>
                      <td className="px-6 py-4 text-sm text-slate-900">{uniform.quantity}</td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          <MapPin className="w-4 h-4 text-slate-400" strokeWidth={1.5} />
                          <span className="text-sm text-slate-600">{uniform.location}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <span
                          className={`inline-flex items-center px-2.5 py-0.5 rounded text-xs ${
                            uniform.status === "In Stock"
                              ? "bg-green-50 text-green-700"
                              : "bg-amber-50 text-amber-700"
                          }`}
                        >
                          {uniform.status}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <Button variant="ghost" size="sm" onClick={() => manageUniformStock(uniform)}>
                          Manage Stock
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {activeTab === "issuance" && (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Employee</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Item</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Type</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Location</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Issued Date</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Return Date</th>
                    <th className="text-left px-6 py-3 text-sm text-slate-500">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {issuanceRecords.map((record) => (
                    <tr key={record.id} className="hover:bg-slate-50 transition-colors">
                      <td className="px-6 py-4 text-sm text-slate-900">{record.employee}</td>
                      <td className="px-6 py-4 text-sm text-slate-600">{record.item}</td>
                      <td className="px-6 py-4">
                        <span
                          className={`inline-flex items-center px-2.5 py-0.5 rounded text-xs ${
                            record.type === "Weapon"
                              ? "bg-red-50 text-red-700"
                              : "bg-blue-50 text-blue-700"
                          }`}
                        >
                          {record.type}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-sm text-slate-600">{record.location}</td>
                      <td className="px-6 py-4 text-sm text-slate-600">{record.issuedDate}</td>
                      <td className="px-6 py-4 text-sm text-slate-600">{record.returnDate}</td>
                      <td className="px-6 py-4">
                        <Button variant="ghost" size="sm" onClick={() => markReturned(record)}>
                          Mark Returned
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <Modal isOpen={isIssueModalOpen} onClose={() => setIsIssueModalOpen(false)} title="Issue Item" size="md">
        <form className="space-y-4">
          <div>
            <label className="block text-sm text-slate-700 mb-1">Item Type</label>
            <select className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent">
              <option>Weapon</option>
              <option>Uniform</option>
            </select>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Select Item</label>
            <select className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent">
              <option>Glock 17 (GL-002-2024)</option>
              <option>Security Guard Uniform (L)</option>
            </select>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Issue To (Employee)</label>
            <select className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent">
              <option>Muhammad Usman</option>
              <option>Ayesha Malik</option>
              <option>Bilal Ahmed</option>
            </select>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Location</label>
            <select className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent">
              <option>F-10 Islamabad</option>
              <option>F-7 Islamabad</option>
            </select>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Issue Date</label>
            <input
              type="date"
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
            />
          </div>
          <div className="flex items-center gap-3 pt-4">
            <Button variant="primary" size="md" className="flex-1">
              Issue Item
            </Button>
            <Button variant="secondary" size="md" onClick={() => setIsIssueModalOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </Modal>

      <Modal isOpen={isWeaponDetailsModalOpen} onClose={() => setIsWeaponDetailsModalOpen(false)} title="Weapon Details" size="md">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-sm text-slate-500 mb-1">Type</p>
              <p className="text-sm text-slate-900">{selectedWeapon?.type}</p>
            </div>
            <div>
              <p className="text-sm text-slate-500 mb-1">Serial Number</p>
              <p className="text-sm text-slate-900">{selectedWeapon?.serialNo}</p>
            </div>
            <div>
              <p className="text-sm text-slate-500 mb-1">Status</p>
              <span
                className={`inline-flex items-center px-2.5 py-0.5 rounded text-xs ${
                  selectedWeapon?.status === "Issued"
                    ? "bg-blue-50 text-blue-700"
                    : selectedWeapon?.status === "Available"
                    ? "bg-green-50 text-green-700"
                    : "bg-amber-50 text-amber-700"
                }`}
              >
                {selectedWeapon?.status}
              </span>
            </div>
            <div>
              <p className="text-sm text-slate-500 mb-1">Location</p>
              <p className="text-sm text-slate-900">{selectedWeapon?.location}</p>
            </div>
            <div>
              <p className="text-sm text-slate-500 mb-1">Issued To</p>
              <p className="text-sm text-slate-900">{selectedWeapon?.issuedTo}</p>
            </div>
            <div>
              <p className="text-sm text-slate-500 mb-1">License Expiry</p>
              <p className="text-sm text-slate-900">{selectedWeapon?.licenseExpiry}</p>
            </div>
          </div>
          <div className="pt-4 border-t border-slate-200">
            <Button variant="secondary" size="md" className="w-full" onClick={() => setIsWeaponDetailsModalOpen(false)}>
              Close
            </Button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={isUniformStockModalOpen} onClose={() => setIsUniformStockModalOpen(false)} title="Manage Stock" size="md">
        <form className="space-y-4">
          <div>
            <p className="text-sm text-slate-900 mb-4">
              {selectedUniform?.type} - Size {selectedUniform?.size}
            </p>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Current Quantity</label>
            <input
              type="number"
              defaultValue={selectedUniform?.quantity}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Add/Remove Stock</label>
            <div className="flex gap-3">
              <input
                type="number"
                placeholder="Enter quantity"
                className="flex-1 px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
              />
              <select className="px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent">
                <option>Add</option>
                <option>Remove</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Notes</label>
            <textarea
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
              rows={3}
              placeholder="Enter notes about stock update"
            />
          </div>
          <div className="flex items-center gap-3 pt-4">
            <Button variant="primary" size="md" className="flex-1">
              Update Stock
            </Button>
            <Button variant="secondary" size="md" onClick={() => setIsUniformStockModalOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </Modal>

      <Modal isOpen={isReturnModalOpen} onClose={() => setIsReturnModalOpen(false)} title="Mark Item as Returned" size="md">
        <form className="space-y-4">
          <div>
            <p className="text-sm text-slate-900 mb-1">Employee: {selectedIssuance?.employee}</p>
            <p className="text-sm text-slate-600 mb-4">Item: {selectedIssuance?.item}</p>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Return Date</label>
            <input
              type="date"
              defaultValue={new Date().toISOString().split('T')[0]}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Condition</label>
            <select className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent">
              <option>Good</option>
              <option>Fair</option>
              <option>Damaged</option>
            </select>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Notes</label>
            <textarea
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
              rows={3}
              placeholder="Enter any notes about the return"
            />
          </div>
          <div className="flex items-center gap-3 pt-4">
            <Button variant="primary" size="md" className="flex-1">
              Mark as Returned
            </Button>
            <Button variant="secondary" size="md" onClick={() => setIsReturnModalOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
