/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import {onUnexpectedError} from 'vs/base/common/errors';
import * as strings from 'vs/base/common/strings';
import {ReplaceCommand, ReplaceCommandWithOffsetCursorState, ReplaceCommandWithoutChangingPosition} from 'vs/editor/common/commands/replaceCommand';
import {ShiftCommand} from 'vs/editor/common/commands/shiftCommand';
import {SurroundSelectionCommand} from 'vs/editor/common/commands/surroundSelectionCommand';
import {CursorMoveHelper, ICursorMoveHelperModel, IMoveResult} from 'vs/editor/common/controller/cursorMoveHelper';
import {Position} from 'vs/editor/common/core/position';
import {Range} from 'vs/editor/common/core/range';
import {Selection} from 'vs/editor/common/core/selection';
import * as editorCommon from 'vs/editor/common/editorCommon';
import {IElectricAction, IndentAction} from 'vs/editor/common/modes';
import {getEnterActionAtPosition} from 'vs/editor/common/modes/supports/onEnter';

export interface IPostOperationRunnable {
	(ctx: IOneCursorOperationContext): void;
}

export interface IOneCursorOperationContext {
	cursorPositionChangeReason: string;
	shouldReveal: boolean;
	shouldRevealVerticalInCenter: boolean;
	shouldRevealHorizontal: boolean;
	shouldPushStackElementBefore: boolean;
	shouldPushStackElementAfter: boolean;
	executeCommand: editorCommon.ICommand;
	postOperationRunnable: IPostOperationRunnable;
	requestScrollDeltaLines: number;
}

export interface IModeConfiguration {

	electricChars:{
		[key:string]:boolean;
	};

	autoClosingPairsOpen:{
		[key:string]:string;
	};

	autoClosingPairsClose:{
		[key:string]:string;
	};

	surroundingPairs:{
		[key:string]:string;
	};
}

export interface IViewModelHelper {

	viewModel:ICursorMoveHelperModel;

	convertModelPositionToViewPosition(lineNumber:number, column:number): editorCommon.IEditorPosition;
	convertModelRangeToViewRange(modelRange:editorCommon.IEditorRange): editorCommon.IEditorRange;

	convertViewToModelPosition(lineNumber:number, column:number): editorCommon.IEditorPosition;

	validateViewPosition(viewLineNumber:number, viewColumn:number, modelPosition:editorCommon.IEditorPosition): editorCommon.IEditorPosition;
	validateViewRange(viewStartLineNumber:number, viewStartColumn:number, viewEndLineNumber:number, viewEndColumn:number, modelRange:editorCommon.IEditorRange): editorCommon.IEditorRange;
}

export interface IOneCursorState {
	selectionStart: editorCommon.IEditorRange;
	viewSelectionStart: editorCommon.IEditorRange;
	position: editorCommon.IEditorPosition;
	viewPosition: editorCommon.IEditorPosition;
	leftoverVisibleColumns: number;
	selectionStartLeftoverVisibleColumns: number;
}

export interface IFindWordResult extends editorCommon.IWordRange {
	wordType: WordType;
}

export enum WordType {
	None = 0,
	Regular = 1,
	Separator = 2
};

enum CharacterClass {
	Regular = 0,
	Whitespace = 1,
	WordSeparator = 2
};

const CH_REGULAR = CharacterClass.Regular;
const CH_WHITESPACE = CharacterClass.Whitespace;
const CH_WORD_SEPARATOR = CharacterClass.WordSeparator;

const W_NONE = WordType.None;
const W_REGULAR = WordType.Regular;
const W_SEPARATOR = WordType.Separator;

export class OneCursor {

	// --- contextual state
	private editorId: number;
	public model: editorCommon.IModel;
	public configuration: editorCommon.IConfiguration;
	public modeConfiguration: IModeConfiguration;
	private helper: CursorHelper;
	private viewModelHelper:IViewModelHelper;

	// --- selection can start as a range (think double click and drag)
	private selectionStart: editorCommon.IEditorRange;
	private viewSelectionStart: editorCommon.IEditorRange;
	private selectionStartLeftoverVisibleColumns: number;

	// --- position
	private position: editorCommon.IEditorPosition;
	private viewPosition: editorCommon.IEditorPosition;
	private leftoverVisibleColumns: number;

	// --- bracket match decorations
	private bracketDecorations: string[];

	// --- computed properties
	private _cachedSelection: editorCommon.IEditorSelection;
	private _cachedViewSelection: editorCommon.IEditorSelection;
	private _selStartMarker: string;
	private _selEndMarker: string;
	private _selDirection: editorCommon.SelectionDirection;

	constructor(editorId: number, model: editorCommon.IModel, configuration: editorCommon.IConfiguration, modeConfiguration: IModeConfiguration, viewModelHelper:IViewModelHelper) {
		this.editorId = editorId;
		this.model = model;
		this.configuration = configuration;
		this.modeConfiguration = modeConfiguration;
		this.viewModelHelper = viewModelHelper;
		this.helper = new CursorHelper(this.model, this.configuration);

		this.bracketDecorations = [];

		this._set(
			new Range(1, 1, 1, 1), 0,
			new Position(1, 1), 0,
			new Range(1, 1, 1, 1), new Position(1, 1)
		);
	}

	private _set(
		selectionStart: editorCommon.IEditorRange, selectionStartLeftoverVisibleColumns: number,
		position: editorCommon.IEditorPosition, leftoverVisibleColumns:number,
		viewSelectionStart: editorCommon.IEditorRange, viewPosition: editorCommon.IEditorPosition
	): void {
		this.selectionStart = selectionStart;
		this.selectionStartLeftoverVisibleColumns = selectionStartLeftoverVisibleColumns;

		this.position = position;
		this.leftoverVisibleColumns = leftoverVisibleColumns;

		this.viewSelectionStart = viewSelectionStart;
		this.viewPosition = viewPosition;

		this._cachedSelection = OneCursor.computeSelection(this.selectionStart, this.position);
		this._cachedViewSelection = OneCursor.computeSelection(this.viewSelectionStart, this.viewPosition);

		this._selStartMarker = this._ensureMarker(this._selStartMarker, this._cachedSelection.startLineNumber, this._cachedSelection.startColumn, true);
		this._selEndMarker = this._ensureMarker(this._selEndMarker, this._cachedSelection.endLineNumber, this._cachedSelection.endColumn, false);
		this._selDirection = this._cachedSelection.getDirection();
	}

	private _ensureMarker(markerId:string, lineNumber:number, column:number, stickToPreviousCharacter:boolean): string {
		if (!markerId) {
			return this.model._addMarker(lineNumber, column, stickToPreviousCharacter);
		} else {
			this.model._changeMarker(markerId, lineNumber, column);
			this.model._changeMarkerStickiness(markerId, stickToPreviousCharacter);
			return markerId;
		}
	}

	public saveState(): IOneCursorState {
		return {
			selectionStart: this.selectionStart,
			viewSelectionStart: this.viewSelectionStart,
			position: this.position,
			viewPosition: this.viewPosition,
			leftoverVisibleColumns: this.leftoverVisibleColumns,
			selectionStartLeftoverVisibleColumns: this.selectionStartLeftoverVisibleColumns
		};
	}

	public restoreState(state:IOneCursorState): void {
		let position = this.model.validatePosition(state.position);
		let selectionStart: editorCommon.IEditorRange;
		if (state.selectionStart) {
			selectionStart = this.model.validateRange(state.selectionStart);
		} else {
			selectionStart = new Range(position.lineNumber, position.column, position.lineNumber, position.column);
		}

		let viewPosition = this.viewModelHelper.validateViewPosition(state.viewPosition.lineNumber, state.viewPosition.column, position);
		let viewSelectionStart: editorCommon.IEditorRange;
		if (state.viewSelectionStart) {
			viewSelectionStart = this.viewModelHelper.validateViewRange(state.viewSelectionStart.startLineNumber, state.viewSelectionStart.startColumn, state.viewSelectionStart.endLineNumber, state.viewSelectionStart.endColumn, selectionStart);
		} else {
			viewSelectionStart = this.viewModelHelper.convertModelRangeToViewRange(selectionStart);
		}

		this._set(
			selectionStart, state.selectionStartLeftoverVisibleColumns,
			position, state.leftoverVisibleColumns,
			viewSelectionStart, viewPosition
		);
	}

	public updateModeConfiguration(modeConfiguration: IModeConfiguration): void {
		this.modeConfiguration = modeConfiguration;
	}

	public duplicate(): OneCursor {
		let result = new OneCursor(this.editorId, this.model, this.configuration, this.modeConfiguration, this.viewModelHelper);
		result._set(
			this.selectionStart, this.selectionStartLeftoverVisibleColumns,
			this.position, this.leftoverVisibleColumns,
			this.viewSelectionStart, this.viewPosition
		);
		return result;
	}

	public dispose(): void {
		this.model._removeMarker(this._selStartMarker);
		this.model._removeMarker(this._selEndMarker);
		this.bracketDecorations = this.model.deltaDecorations(this.bracketDecorations, [], this.editorId);
	}

	public adjustBracketDecorations(): void {
		let bracketMatch: editorCommon.IMatchBracketResult = null;
		let selection = this.getSelection();
		if (selection.isEmpty()) {
			bracketMatch = this.model.matchBracket(this.position, /*inaccurateResultAcceptable*/true);
		}

		let newDecorations: editorCommon.IModelDeltaDecoration[] = [];
		if (bracketMatch && bracketMatch.brackets) {
			let options: editorCommon.IModelDecorationOptions = {
				stickiness: editorCommon.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
				className: 'bracket-match'
			};
			newDecorations.push({ range: bracketMatch.brackets[0], options: options });
			newDecorations.push({ range: bracketMatch.brackets[1], options: options });
		}

		this.bracketDecorations = this.model.deltaDecorations(this.bracketDecorations, newDecorations, this.editorId);
	}

	private static computeSelection(selectionStart:editorCommon.IEditorRange, position:editorCommon.IEditorPosition): Selection {
		let startLineNumber: number, startColumn: number, endLineNumber: number, endColumn: number;
		if (selectionStart.isEmpty()) {
			startLineNumber = selectionStart.startLineNumber;
			startColumn = selectionStart.startColumn;
			endLineNumber = position.lineNumber;
			endColumn = position.column;
		} else {
			if (position.isBeforeOrEqual(selectionStart.getStartPosition())) {
				startLineNumber = selectionStart.endLineNumber;
				startColumn = selectionStart.endColumn;
				endLineNumber = position.lineNumber;
				endColumn = position.column;
			} else {
				startLineNumber = selectionStart.startLineNumber;
				startColumn = selectionStart.startColumn;
				endLineNumber = position.lineNumber;
				endColumn = position.column;
			}
		}
		return new Selection(
			startLineNumber,
			startColumn,
			endLineNumber,
			endColumn
		);
	}

	public setSelection(desiredSelection: editorCommon.ISelection): void {
		let position = this.model.validatePosition({
			lineNumber: desiredSelection.positionLineNumber,
			column: desiredSelection.positionColumn
		});
		let selectionStartPosition = this.model.validatePosition({
			lineNumber: desiredSelection.selectionStartLineNumber,
			column: desiredSelection.selectionStartColumn
		});
		let selectionStart = new Range(selectionStartPosition.lineNumber, selectionStartPosition.column, selectionStartPosition.lineNumber, selectionStartPosition.column);

		let viewPosition = this.viewModelHelper.convertModelPositionToViewPosition(position.lineNumber, position.column);
		let viewSelectionStart = this.viewModelHelper.convertModelRangeToViewRange(selectionStart);

		this._set(
			selectionStart, 0,
			position, 0,
			viewSelectionStart, viewPosition
		);
	}

	// -------------------- START modifications

	public setSelectionStart(rng:editorCommon.IEditorRange, viewRng:editorCommon.IEditorRange): void {
		this._set(
			rng, this.selectionStartLeftoverVisibleColumns,
			this.position, this.leftoverVisibleColumns,
			viewRng, this.viewPosition
		);
	}

	public collapseSelection(): void {
		let selectionStart = new Range(this.position.lineNumber, this.position.column, this.position.lineNumber, this.position.column);
		let viewSelectionStart = new Range(this.viewPosition.lineNumber, this.viewPosition.column, this.viewPosition.lineNumber, this.viewPosition.column);
		this._set(
			selectionStart, 0,
			this.position, this.leftoverVisibleColumns,
			viewSelectionStart, this.viewPosition
		);
	}

	public moveModelPosition(inSelectionMode:boolean, lineNumber:number, column:number, leftoverVisibleColumns: number, ensureInEditableRange: boolean): void {
		let viewPosition = this.viewModelHelper.convertModelPositionToViewPosition(lineNumber, column);
		this._move(inSelectionMode, lineNumber, column, viewPosition.lineNumber, viewPosition.column, leftoverVisibleColumns, ensureInEditableRange);
	}

	public moveViewPosition(inSelectionMode:boolean, viewLineNumber:number, viewColumn:number, leftoverVisibleColumns: number, ensureInEditableRange: boolean): void {
		let modelPosition = this.viewModelHelper.convertViewToModelPosition(viewLineNumber, viewColumn);
		this._move(inSelectionMode, modelPosition.lineNumber, modelPosition.column, viewLineNumber, viewColumn, leftoverVisibleColumns, ensureInEditableRange);
	}

	private _move(inSelectionMode:boolean, lineNumber:number, column:number, viewLineNumber:number, viewColumn:number, leftoverVisibleColumns: number, ensureInEditableRange: boolean): void {

		if (ensureInEditableRange) {
			let editableRange = this.model.getEditableRange();

			if (lineNumber < editableRange.startLineNumber || (lineNumber === editableRange.startLineNumber && column < editableRange.startColumn)) {
				lineNumber = editableRange.startLineNumber;
				column = editableRange.startColumn;

				let viewPosition = this.viewModelHelper.convertModelPositionToViewPosition(lineNumber, column);
				viewLineNumber = viewPosition.lineNumber;
				viewColumn = viewPosition.column;
			} else if (lineNumber > editableRange.endLineNumber || (lineNumber === editableRange.endLineNumber && column > editableRange.endColumn)) {
				lineNumber = editableRange.endLineNumber;
				column = editableRange.endColumn;

				let viewPosition = this.viewModelHelper.convertModelPositionToViewPosition(lineNumber, column);
				viewLineNumber = viewPosition.lineNumber;
				viewColumn = viewPosition.column;
			}
		}

		this._actualMove(inSelectionMode, new Position(lineNumber, column), new Position(viewLineNumber, viewColumn), leftoverVisibleColumns);
	}

	private _actualMove(inSelectionMode:boolean, position:Position, viewPosition:Position, leftoverVisibleColumns: number): void {
		if (inSelectionMode) {
			// move just position
			this._set(
				this.selectionStart, this.selectionStartLeftoverVisibleColumns,
				position, leftoverVisibleColumns,
				this.viewSelectionStart, viewPosition
			);
		} else {
			// move everything
			let selectionStart = new Range(position.lineNumber, position.column, position.lineNumber, position.column);
			let viewSelectionStart = new Range(viewPosition.lineNumber, viewPosition.column, viewPosition.lineNumber, viewPosition.column);
			this._set(
				selectionStart, leftoverVisibleColumns,
				position, leftoverVisibleColumns,
				viewSelectionStart, viewPosition
			);
		}
	}

	private _recoverSelectionFromMarkers(): Selection {
		let start = this.model._getMarker(this._selStartMarker);
		let end = this.model._getMarker(this._selEndMarker);

		if (this._selDirection === editorCommon.SelectionDirection.LTR) {
			return new Selection(start.lineNumber, start.column, end.lineNumber, end.column);
		}

		return new Selection(end.lineNumber, end.column, start.lineNumber, start.column);
	}

	public recoverSelectionFromMarkers(ctx: IOneCursorOperationContext): boolean {
		ctx.cursorPositionChangeReason = 'recoverFromMarkers';
		ctx.shouldPushStackElementBefore = true;
		ctx.shouldPushStackElementAfter = true;
		ctx.shouldReveal = false;
		ctx.shouldRevealHorizontal = false;

		let recoveredSelection = this._recoverSelectionFromMarkers();

		let selectionStart = new Range(recoveredSelection.selectionStartLineNumber, recoveredSelection.selectionStartColumn, recoveredSelection.selectionStartLineNumber, recoveredSelection.selectionStartColumn);
		let position = new Position(recoveredSelection.positionLineNumber, recoveredSelection.positionColumn);

		let viewSelectionStart = this.viewModelHelper.convertModelRangeToViewRange(selectionStart);
		let viewPosition = this.viewModelHelper.convertViewToModelPosition(position.lineNumber, position.column);

		this._set(
			selectionStart, 0,
			position, 0,
			viewSelectionStart, viewPosition
		);

		return true;
	}

	// -------------------- END modifications

	// -------------------- START reading API

	public getSelectionStart(): editorCommon.IEditorRange {
		return this.selectionStart;
	}
	public getPosition(): editorCommon.IEditorPosition {
		return this.position;
	}
	public getSelection(): editorCommon.IEditorSelection {
		return this._cachedSelection;
	}

	public getViewPosition(): editorCommon.IEditorPosition {
		return this.viewPosition;
	}
	public getViewSelection(): editorCommon.IEditorSelection {
		return this._cachedViewSelection;
	}
	public getValidViewPosition(): editorCommon.IEditorPosition {
		return this.viewModelHelper.validateViewPosition(this.viewPosition.lineNumber, this.viewPosition.column, this.position);
	}

	public hasSelection(): boolean {
		return (!this.getSelection().isEmpty() || !this.selectionStart.isEmpty());
	}
	public getBracketsDecorations(): string[] {
		return this.bracketDecorations;
	}
	public getLeftoverVisibleColumns(): number {
		return this.leftoverVisibleColumns;
	}
	public getSelectionStartLeftoverVisibleColumns(): number {
		return this.selectionStartLeftoverVisibleColumns;
	}
	public setSelectionStartLeftoverVisibleColumns(value:number): void {
		this.selectionStartLeftoverVisibleColumns = value;
	}

	// -- utils
	public validatePosition(position:editorCommon.IPosition): editorCommon.IEditorPosition {
		return this.model.validatePosition(position);
	}
	public validateViewPosition(viewLineNumber:number, viewColumn:number, modelPosition:editorCommon.IEditorPosition): editorCommon.IEditorPosition {
		return this.viewModelHelper.validateViewPosition(viewLineNumber, viewColumn, modelPosition);
	}
	public convertViewToModelPosition(lineNumber:number, column:number): editorCommon.IPosition {
		return this.viewModelHelper.convertViewToModelPosition(lineNumber, column);
	}
	public convertModelPositionToViewPosition(lineNumber:number, column:number): editorCommon.IPosition {
		return this.viewModelHelper.convertModelPositionToViewPosition(lineNumber, column);
	}

	// -- model
	public getLineContent(lineNumber:number): string {
		return this.model.getLineContent(lineNumber);
	}
	// public findWord(position:editorCommon.IEditorPosition, preference:string, skipSyntaxTokens?:boolean): editorCommon.IWordRange {
	// 	return this.helper.findWord(position, preference, skipSyntaxTokens);
	// }
	public findPreviousWordOnLine(position:editorCommon.IEditorPosition): IFindWordResult {
		return this.helper.findPreviousWordOnLine(position);
	}
	public findNextWordOnLine(position:editorCommon.IEditorPosition): IFindWordResult {
		return this.helper.findNextWordOnLine(position);
	}
	public getLeftOfPosition(lineNumber:number, column:number): editorCommon.IPosition {
		return this.helper.getLeftOfPosition(this.model, lineNumber, column);
	}
	public getRightOfPosition(lineNumber:number, column:number): editorCommon.IPosition {
		return this.helper.getRightOfPosition(this.model, lineNumber, column);
	}
	public getPositionUp(lineNumber:number, column:number, leftoverVisibleColumns:number, count:number, allowMoveOnFirstLine:boolean): IMoveResult {
		return this.helper.getPositionUp(this.model, lineNumber, column, leftoverVisibleColumns, count, allowMoveOnFirstLine);
	}
	public getPositionDown(lineNumber:number, column:number, leftoverVisibleColumns:number, count:number, allowMoveOnLastLine:boolean): IMoveResult {
		return this.helper.getPositionDown(this.model, lineNumber, column, leftoverVisibleColumns, count, allowMoveOnLastLine);
	}
	public getColumnAtBeginningOfLine(lineNumber:number, column:number): number {
		return this.helper.getColumnAtBeginningOfLine(this.model, lineNumber, column);
	}
	public getColumnAtEndOfLine(lineNumber:number, column:number): number {
		return this.helper.getColumnAtEndOfLine(this.model, lineNumber, column);
	}
	public getVisibleColumnFromColumn(lineNumber:number, column:number): number {
		return this.helper.visibleColumnFromColumn(this.model, lineNumber, column);
	}

	// -- view
	public getViewLineCount(): number {
		return this.viewModelHelper.viewModel.getLineCount();
	}
	public getViewLineMaxColumn(lineNumber:number): number {
		return this.viewModelHelper.viewModel.getLineMaxColumn(lineNumber);
	}
	public getLeftOfViewPosition(lineNumber:number, column:number): editorCommon.IPosition {
		return this.helper.getLeftOfPosition(this.viewModelHelper.viewModel, lineNumber, column);
	}
	public getRightOfViewPosition(lineNumber:number, column:number): editorCommon.IPosition {
		return this.helper.getRightOfPosition(this.viewModelHelper.viewModel, lineNumber, column);
	}
	public getViewPositionUp(lineNumber:number, column:number, leftoverVisibleColumns:number, count:number, allowMoveOnFirstLine:boolean): IMoveResult {
		return this.helper.getPositionUp(this.viewModelHelper.viewModel, lineNumber, column, leftoverVisibleColumns, count, allowMoveOnFirstLine);
	}
	public getViewPositionDown(lineNumber:number, column:number, leftoverVisibleColumns:number, count:number, allowMoveOnLastLine:boolean): IMoveResult {
		return this.helper.getPositionDown(this.viewModelHelper.viewModel, lineNumber, column, leftoverVisibleColumns, count, allowMoveOnLastLine);
	}
	public getColumnAtBeginningOfViewLine(lineNumber:number, column:number): number {
		return this.helper.getColumnAtBeginningOfLine(this.viewModelHelper.viewModel, lineNumber, column);
	}
	public getColumnAtEndOfViewLine(lineNumber:number, column:number): number {
		return this.helper.getColumnAtEndOfLine(this.viewModelHelper.viewModel, lineNumber, column);
	}
	// -------------------- END reading API
}

export class OneCursorOp {

	// -------------------- START handlers that simply change cursor state
	public static jumpToBracket(cursor:OneCursor, ctx: IOneCursorOperationContext): boolean {
		let bracketDecorations = cursor.getBracketsDecorations();

		if (bracketDecorations.length !== 2) {
			return false;
		}

		let firstBracket = cursor.model.getDecorationRange(bracketDecorations[0]);
		let secondBracket = cursor.model.getDecorationRange(bracketDecorations[1]);

		let position = cursor.getPosition();

		if (Utils.isPositionAtRangeEdges(position, firstBracket) || Utils.isPositionInsideRange(position, firstBracket)) {
			cursor.moveModelPosition(false, secondBracket.endLineNumber, secondBracket.endColumn, 0, false);
			return true;
		}

		if (Utils.isPositionAtRangeEdges(position, secondBracket) || Utils.isPositionInsideRange(position, secondBracket)) {
			cursor.moveModelPosition(false, firstBracket.endLineNumber, firstBracket.endColumn, 0, false);
			return true;
		}

		return false;
	}

	public static moveTo(cursor:OneCursor, inSelectionMode: boolean, position: editorCommon.IPosition, viewPosition:editorCommon.IPosition, eventSource: string, ctx: IOneCursorOperationContext): boolean {

		var validatedPosition = cursor.model.validatePosition(position);
		var validatedViewPosition: editorCommon.IPosition;
		if (viewPosition) {
			validatedViewPosition = cursor.validateViewPosition(viewPosition.lineNumber, viewPosition.column, validatedPosition);
		} else {
			validatedViewPosition = cursor.convertModelPositionToViewPosition(validatedPosition.lineNumber, validatedPosition.column);
		}

		var reason = (eventSource === 'mouse' ? 'explicit' : null);
		if (eventSource === 'api') {
			ctx.shouldRevealVerticalInCenter = true;
		}

		if (reason) {
			ctx.cursorPositionChangeReason = reason;
		}
		cursor.moveViewPosition(inSelectionMode, validatedViewPosition.lineNumber, validatedViewPosition.column, 0, false);
		return true;
	}

	public static moveLeft(cursor:OneCursor, inSelectionMode: boolean, ctx: IOneCursorOperationContext): boolean {
		var viewLineNumber:number,
			viewColumn:number;

		if (cursor.hasSelection() && !inSelectionMode) {
			// If we are in selection mode, move left without selection cancels selection and puts cursor at the beginning of the selection
			var viewSelection = cursor.getViewSelection();
			var viewSelectionStart = cursor.validateViewPosition(viewSelection.startLineNumber, viewSelection.startColumn, cursor.getSelection().getStartPosition());
			viewLineNumber = viewSelectionStart.lineNumber;
			viewColumn = viewSelectionStart.column;
		} else {
			var validatedViewPosition = cursor.getValidViewPosition();
			var r = cursor.getLeftOfViewPosition(validatedViewPosition.lineNumber, validatedViewPosition.column);
			viewLineNumber = r.lineNumber;
			viewColumn = r.column;
		}

		ctx.cursorPositionChangeReason = 'explicit';
		cursor.moveViewPosition(inSelectionMode, viewLineNumber, viewColumn, 0, true);
		return true;
	}

	public static moveWordLeft(cursor:OneCursor, inSelectionMode: boolean, ctx: IOneCursorOperationContext): boolean {
		let position = cursor.getPosition();
		var lineNumber = position.lineNumber;
		var column = position.column;

		var wentUp = false;
		if (column === 1) {
			if (lineNumber > 1) {
				wentUp = true;
				lineNumber = lineNumber - 1;
				column = cursor.model.getLineMaxColumn(lineNumber);
			}
		}

		let prevWordOnLine = cursor.findPreviousWordOnLine(new Position(lineNumber, column));

		if (prevWordOnLine) {
			column = prevWordOnLine.start + 1;
		} else {
			column = 1;
		}

		ctx.cursorPositionChangeReason = 'explicit';
		cursor.moveModelPosition(inSelectionMode, lineNumber, column, 0, true);
		return true;
	}

	public static moveRight(cursor:OneCursor, inSelectionMode: boolean, ctx: IOneCursorOperationContext): boolean {
		var viewLineNumber:number,
			viewColumn:number;

		if (cursor.hasSelection() && !inSelectionMode) {
			// If we are in selection mode, move right without selection cancels selection and puts cursor at the end of the selection
			var viewSelection = cursor.getViewSelection();
			var viewSelectionEnd = cursor.validateViewPosition(viewSelection.endLineNumber, viewSelection.endColumn, cursor.getSelection().getEndPosition());
			viewLineNumber = viewSelectionEnd.lineNumber;
			viewColumn = viewSelectionEnd.column;
		} else {
			var validatedViewPosition = cursor.getValidViewPosition();
			var r = cursor.getRightOfViewPosition(validatedViewPosition.lineNumber, validatedViewPosition.column);
			viewLineNumber = r.lineNumber;
			viewColumn = r.column;
		}

		ctx.cursorPositionChangeReason = 'explicit';
		cursor.moveViewPosition(inSelectionMode, viewLineNumber, viewColumn, 0, true);
		return true;
	}

	public static moveWordRight(cursor:OneCursor, inSelectionMode: boolean, ctx: IOneCursorOperationContext): boolean {
		let position = cursor.getPosition();
		var lineNumber = position.lineNumber;
		var column = position.column;

		var wentDown = false;
		if (column === cursor.model.getLineMaxColumn(lineNumber)) {
			if (lineNumber < cursor.model.getLineCount()) {
				wentDown = true;
				lineNumber = lineNumber + 1;
				column = 1;
			}
		}

		let nextWordOnLine = cursor.findNextWordOnLine(new Position(lineNumber, column));

		if (nextWordOnLine) {
			column = nextWordOnLine.end + 1;
		} else {
			column = cursor.model.getLineMaxColumn(lineNumber);
		}

		ctx.cursorPositionChangeReason = 'explicit';
		cursor.moveModelPosition(inSelectionMode, lineNumber, column, 0, true);
		return true;
	}

	public static moveDown(cursor:OneCursor, inSelectionMode: boolean, isPaged: boolean, ctx: IOneCursorOperationContext): boolean {
		var linesCount = isPaged ? cursor.configuration.editor.pageSize : 1;

		var viewLineNumber:number,
			viewColumn:number;

		if (cursor.hasSelection() && !inSelectionMode) {
			// If we are in selection mode, move down acts relative to the end of selection
			var viewSelection = cursor.getViewSelection();
			var viewSelectionEnd = cursor.validateViewPosition(viewSelection.endLineNumber, viewSelection.endColumn, cursor.getSelection().getEndPosition());
			viewLineNumber = viewSelectionEnd.lineNumber;
			viewColumn = viewSelectionEnd.column;
		} else {
			var validatedViewPosition = cursor.getValidViewPosition();
			viewLineNumber = validatedViewPosition.lineNumber;
			viewColumn = validatedViewPosition.column;
		}

		var r = cursor.getViewPositionDown(viewLineNumber, viewColumn, cursor.getLeftoverVisibleColumns(), linesCount, true);
		ctx.cursorPositionChangeReason = 'explicit';
		cursor.moveViewPosition(inSelectionMode, r.lineNumber, r.column, r.leftoverVisibleColumns, true);
		return true;
	}

	public static translateDown(cursor:OneCursor, ctx: IOneCursorOperationContext): boolean {

		var selection = cursor.getViewSelection();

		var selectionStart = cursor.getViewPositionDown(selection.selectionStartLineNumber, selection.selectionStartColumn, cursor.getSelectionStartLeftoverVisibleColumns(), 1, false);
		ctx.cursorPositionChangeReason = 'explicit';
		cursor.moveViewPosition(false, selectionStart.lineNumber, selectionStart.column, cursor.getLeftoverVisibleColumns(), true);

		var position = cursor.getViewPositionDown(selection.positionLineNumber, selection.positionColumn, cursor.getLeftoverVisibleColumns(), 1, false);
		ctx.cursorPositionChangeReason = 'explicit';
		cursor.moveViewPosition(true, position.lineNumber, position.column, position.leftoverVisibleColumns, true);

		cursor.setSelectionStartLeftoverVisibleColumns(selectionStart.leftoverVisibleColumns);

		return true;
	}

	public static moveUp(cursor:OneCursor, inSelectionMode: boolean, isPaged: boolean, ctx: IOneCursorOperationContext): boolean {
		var linesCount = isPaged ? cursor.configuration.editor.pageSize : 1;

		var viewLineNumber:number,
			viewColumn:number;

		if (cursor.hasSelection() && !inSelectionMode) {
			// If we are in selection mode, move up acts relative to the beginning of selection
			var viewSelection = cursor.getViewSelection();
			var viewSelectionStart = cursor.validateViewPosition(viewSelection.startLineNumber, viewSelection.startColumn, cursor.getSelection().getStartPosition());
			viewLineNumber = viewSelectionStart.lineNumber;
			viewColumn = viewSelectionStart.column;
		} else {
			var validatedViewPosition = cursor.getValidViewPosition();
			viewLineNumber = validatedViewPosition.lineNumber;
			viewColumn = validatedViewPosition.column;
		}

		var r = cursor.getViewPositionUp(viewLineNumber, viewColumn, cursor.getLeftoverVisibleColumns(), linesCount, true);
		ctx.cursorPositionChangeReason = 'explicit';
		cursor.moveViewPosition(inSelectionMode, r.lineNumber, r.column, r.leftoverVisibleColumns, true);

		return true;
	}

	public static translateUp(cursor:OneCursor, ctx: IOneCursorOperationContext): boolean {

		var selection = cursor.getViewSelection();

		var selectionStart = cursor.getViewPositionUp(selection.selectionStartLineNumber, selection.selectionStartColumn, cursor.getSelectionStartLeftoverVisibleColumns(), 1, false);
		ctx.cursorPositionChangeReason = 'explicit';
		cursor.moveViewPosition(false, selectionStart.lineNumber, selectionStart.column, cursor.getLeftoverVisibleColumns(), true);

		var position = cursor.getViewPositionUp(selection.positionLineNumber, selection.positionColumn, cursor.getLeftoverVisibleColumns(), 1, false);
		ctx.cursorPositionChangeReason = 'explicit';
		cursor.moveViewPosition(true, position.lineNumber, position.column, position.leftoverVisibleColumns, true);

		cursor.setSelectionStartLeftoverVisibleColumns(selectionStart.leftoverVisibleColumns);

		return true;
	}

	public static moveToBeginningOfLine(cursor:OneCursor, inSelectionMode: boolean, ctx: IOneCursorOperationContext): boolean {
		var validatedViewPosition = cursor.getValidViewPosition();
		var viewLineNumber = validatedViewPosition.lineNumber;
		var viewColumn = validatedViewPosition.column;

		viewColumn = cursor.getColumnAtBeginningOfViewLine(viewLineNumber, viewColumn);
		ctx.cursorPositionChangeReason = 'explicit';
		cursor.moveViewPosition(inSelectionMode, viewLineNumber, viewColumn, 0, true);
		return true;
	}

	public static moveToEndOfLine(cursor:OneCursor, inSelectionMode: boolean, ctx: IOneCursorOperationContext): boolean {
		var validatedViewPosition = cursor.getValidViewPosition();
		var viewLineNumber = validatedViewPosition.lineNumber;
		var viewColumn = validatedViewPosition.column;

		viewColumn = cursor.getColumnAtEndOfViewLine(viewLineNumber, viewColumn);
		ctx.cursorPositionChangeReason = 'explicit';
		cursor.moveViewPosition(inSelectionMode, viewLineNumber, viewColumn, 0, true);
		return true;
	}

	public static expandLineSelection(cursor:OneCursor, ctx: IOneCursorOperationContext): boolean {
		ctx.cursorPositionChangeReason = 'explicit';
		let viewSel = cursor.getViewSelection();

		let viewStartLineNumber = viewSel.startLineNumber;
		let viewStartColumn = viewSel.startColumn;
		let viewEndLineNumber = viewSel.endLineNumber;
		let viewEndColumn = viewSel.endColumn;

		let viewEndMaxColumn = cursor.getViewLineMaxColumn(viewEndLineNumber);
		if (viewStartColumn !== 1 || viewEndColumn !== viewEndMaxColumn) {
			viewStartColumn = 1;
			viewEndColumn = viewEndMaxColumn;
		} else {
			// Expand selection with one more line down
			let moveResult = cursor.getViewPositionDown(viewEndLineNumber, viewEndColumn, 0, 1, true);
			viewEndLineNumber = moveResult.lineNumber;
			viewEndColumn = cursor.getViewLineMaxColumn(viewEndLineNumber);
		}

		cursor.moveViewPosition(false, viewStartLineNumber, viewStartColumn, 0, true);
		cursor.moveViewPosition(true, viewEndLineNumber, viewEndColumn, 0, true);
		return true;
	}

	public static moveToBeginningOfBuffer(cursor:OneCursor, inSelectionMode: boolean, ctx: IOneCursorOperationContext): boolean {
		ctx.cursorPositionChangeReason = 'explicit';
		cursor.moveModelPosition(inSelectionMode, 1, 1, 0, true);
		return true;
	}

	public static moveToEndOfBuffer(cursor:OneCursor, inSelectionMode: boolean, ctx: IOneCursorOperationContext): boolean {
		var lastLineNumber = cursor.model.getLineCount();
		var lastColumn = cursor.model.getLineMaxColumn(lastLineNumber);

		ctx.cursorPositionChangeReason = 'explicit';
		cursor.moveModelPosition(inSelectionMode, lastLineNumber, lastColumn, 0, true);
		return true;
	}

	public static selectAll(cursor:OneCursor, ctx: IOneCursorOperationContext): boolean {

		var selectEntireBuffer = true;
		var newSelectionStartLineNumber: number,
			newSelectionStartColumn: number,
			newPositionLineNumber: number,
			newPositionColumn: number;

		if (cursor.model.hasEditableRange()) {
			// Toggle between selecting editable range and selecting the entire buffer

			var editableRange = cursor.model.getEditableRange();
			var selection = cursor.getSelection();

			if (!selection.equalsRange(editableRange)) {
				// Selection is not editable range => select editable range
				selectEntireBuffer = false;
				newSelectionStartLineNumber = editableRange.startLineNumber;
				newSelectionStartColumn = editableRange.startColumn;
				newPositionLineNumber = editableRange.endLineNumber;
				newPositionColumn = editableRange.endColumn;
			}
		}

		if (selectEntireBuffer) {
			newSelectionStartLineNumber = 1;
			newSelectionStartColumn = 1;
			newPositionLineNumber = cursor.model.getLineCount();
			newPositionColumn = cursor.model.getLineMaxColumn(newPositionLineNumber);
		}

		cursor.moveModelPosition(false, newSelectionStartLineNumber, newSelectionStartColumn, 0, false);
		cursor.moveModelPosition(true, newPositionLineNumber, newPositionColumn, 0, false);

		ctx.shouldReveal = false;
		ctx.shouldRevealHorizontal = false;
		return true;
	}

	public static line(cursor:OneCursor, inSelectionMode: boolean, _position:editorCommon.IPosition, _viewPosition:editorCommon.IPosition, ctx: IOneCursorOperationContext): boolean {
		// TODO@Alex -> select in editable range

		let position = cursor.validatePosition(_position);
		let viewPosition = (
			_viewPosition ?
			cursor.validateViewPosition(_viewPosition.lineNumber, _viewPosition.column, position)
			: cursor.convertModelPositionToViewPosition(position.lineNumber, position.column)
		);

		ctx.cursorPositionChangeReason = 'explicit';
		ctx.shouldRevealHorizontal = false;

		if (!inSelectionMode || !cursor.hasSelection()) {
			// Entering line selection for the first time

			let selectToLineNumber = position.lineNumber + 1;
			let selectToColumn = 1;
			if (selectToLineNumber > cursor.model.getLineCount()) {
				selectToLineNumber = cursor.model.getLineCount();
				selectToColumn = cursor.model.getLineMaxColumn(selectToLineNumber);
			}

			let selectionStartRange = new Range(position.lineNumber, 1, selectToLineNumber, selectToColumn);
			let r1 = cursor.convertModelPositionToViewPosition(position.lineNumber, 1);
			let r2 = cursor.convertModelPositionToViewPosition(selectToLineNumber, selectToColumn);
			cursor.setSelectionStart(selectionStartRange, new Range(r1.lineNumber, r1.column, r2.lineNumber, r2.column));
			cursor.moveModelPosition(cursor.hasSelection(), selectionStartRange.endLineNumber, selectionStartRange.endColumn, 0, false);

			return true;
		} else {
			// Continuing line selection
			let enteringLineNumber = cursor.getSelectionStart().getStartPosition().lineNumber;

			if (position.lineNumber < enteringLineNumber) {

				cursor.moveViewPosition(cursor.hasSelection(), viewPosition.lineNumber, 1, 0, false);

			} else if (position.lineNumber > enteringLineNumber) {

				let selectToViewLineNumber = viewPosition.lineNumber + 1;
				let selectToViewColumn = 1;
				if (selectToViewLineNumber > cursor.getViewLineCount()) {
					selectToViewLineNumber = cursor.getViewLineCount();
					selectToViewColumn = cursor.getViewLineMaxColumn(selectToViewLineNumber);
				}
				cursor.moveViewPosition(cursor.hasSelection(), selectToViewLineNumber, selectToViewColumn, 0, false);

			} else {

				let endPositionOfSelectionStart = cursor.getSelectionStart().getEndPosition();
				cursor.moveModelPosition(cursor.hasSelection(), endPositionOfSelectionStart.lineNumber, endPositionOfSelectionStart.column, 0, false);

			}


			return true;
		}

	}

	public static word(cursor:OneCursor, inSelectionMode: boolean, position: editorCommon.IPosition, preference: string, ctx: IOneCursorOperationContext): boolean {
		// TODO@Alex -> select in editable range

		let validatedPosition = cursor.validatePosition(position);
		let prevWord = cursor.findPreviousWordOnLine(validatedPosition);
		let isInPrevWord = (prevWord && prevWord.wordType === WordType.Regular && prevWord.start < validatedPosition.column - 1 && validatedPosition.column - 1 <= prevWord.end);
		let nextWord = cursor.findNextWordOnLine(validatedPosition);
		let isInNextWord = (nextWord && nextWord.wordType === WordType.Regular && nextWord.start < validatedPosition.column - 1 && validatedPosition.column - 1 <= nextWord.end);

		let lineNumber: number;
		let column: number;
		if (!inSelectionMode || !cursor.hasSelection()) {

			let startColumn: number;
			let endColumn: number;

			if (isInPrevWord) {
				startColumn = prevWord.start + 1;
				endColumn = prevWord.end + 1;
			} else if (isInNextWord) {
				startColumn = nextWord.start + 1;
				endColumn = nextWord.end + 1;
			} else {
				if (prevWord) {
					startColumn = prevWord.end + 1;
				} else {
					startColumn = 1;
				}
				if (nextWord) {
					endColumn = nextWord.start + 1;
				} else {
					endColumn = cursor.model.getLineMaxColumn(validatedPosition.lineNumber);
				}
			}

			let selectionStartRange = new Range(validatedPosition.lineNumber, startColumn, validatedPosition.lineNumber, endColumn);
			let r1 = cursor.convertModelPositionToViewPosition(validatedPosition.lineNumber, startColumn);
			let r2 = cursor.convertModelPositionToViewPosition(validatedPosition.lineNumber, endColumn);
			cursor.setSelectionStart(selectionStartRange, new Range(r1.lineNumber, r1.column, r2.lineNumber, r2.column));
			lineNumber = selectionStartRange.endLineNumber;
			column = selectionStartRange.endColumn;
		} else {

			let startColumn: number;
			let endColumn: number;

			if (isInPrevWord) {
				startColumn = prevWord.start + 1;
				endColumn = prevWord.end + 1;
			} else if (isInNextWord) {
				startColumn = nextWord.start + 1;
				endColumn = nextWord.end + 1;
			} else {
				startColumn = validatedPosition.column;
				endColumn = validatedPosition.column;
			}

			lineNumber = validatedPosition.lineNumber;
			if (validatedPosition.isBeforeOrEqual(cursor.getSelectionStart().getStartPosition())) {
				column = startColumn;
				let possiblePosition = new Position(lineNumber, column);
				if (cursor.getSelectionStart().containsPosition(possiblePosition)) {
					column = cursor.getSelectionStart().endColumn;
				}
			} else {
				column = endColumn;
				let possiblePosition = new Position(lineNumber, column);
				if (cursor.getSelectionStart().containsPosition(possiblePosition)) {
					column = cursor.getSelectionStart().startColumn;
				}
			}
		}

		ctx.cursorPositionChangeReason = 'explicit';
		cursor.moveModelPosition(cursor.hasSelection(), lineNumber, column, 0, false);
		return true;
	}

	public static cancelSelection(cursor:OneCursor, ctx: IOneCursorOperationContext): boolean {
		if (!cursor.hasSelection()) {
			return false;
		}

		cursor.collapseSelection();
		return true;
	}

	// -------------------- STOP handlers that simply change cursor state



	// -------------------- START type interceptors & co.

	private static _typeInterceptorEnter(cursor:OneCursor, ch: string, ctx: IOneCursorOperationContext): boolean {
		if (ch !== '\n') {
			return false;
		}

		return this._enter(cursor, false, ctx);
	}

	public static lineInsertBefore(cursor:OneCursor, ctx: IOneCursorOperationContext): boolean {
		var lineNumber = cursor.getPosition().lineNumber;

		if (lineNumber === 1) {
			ctx.executeCommand = new ReplaceCommandWithoutChangingPosition(new Range(1,1,1,1), '\n');
			return true;
		}

		lineNumber--;
		var column = cursor.model.getLineMaxColumn(lineNumber);

		return this._enter(cursor, false, ctx, new Position(lineNumber, column), new Range(lineNumber, column, lineNumber, column));
	}

	public static lineInsertAfter(cursor:OneCursor, ctx: IOneCursorOperationContext): boolean {
		let position = cursor.getPosition();
		var column = cursor.model.getLineMaxColumn(position.lineNumber);
		return this._enter(cursor, false, ctx, new Position(position.lineNumber, column), new Range(position.lineNumber, column, position.lineNumber, column));
	}

	public static lineBreakInsert(cursor:OneCursor, ctx: IOneCursorOperationContext): boolean {
		return this._enter(cursor, true, ctx);
	}

	private static _enter(cursor:OneCursor, keepPosition: boolean, ctx: IOneCursorOperationContext, position?: editorCommon.IEditorPosition, range?: editorCommon.IEditorRange): boolean {
		if (typeof position === 'undefined') {
			position = cursor.getPosition();
		}
		if (typeof range === 'undefined') {
			range = cursor.getSelection();
		}
		ctx.shouldPushStackElementBefore = true;

		var r = getEnterActionAtPosition(cursor.model, position.lineNumber, position.column);
		var enterAction = r.enterAction;
		var indentation = r.indentation;

		if (enterAction.indentAction === IndentAction.None) {
			// Nothing special
			this.actualType(cursor, '\n' + cursor.configuration.normalizeIndentation(indentation + enterAction.appendText), keepPosition, ctx, range);

		} else if (enterAction.indentAction === IndentAction.Indent) {
			// Indent once
			this.actualType(cursor, '\n' + cursor.configuration.normalizeIndentation(indentation + enterAction.appendText), keepPosition, ctx, range);

		} else if (enterAction.indentAction === IndentAction.IndentOutdent) {
			// Ultra special
			let normalIndent = cursor.configuration.normalizeIndentation(indentation);
			let increasedIndent = cursor.configuration.normalizeIndentation(indentation + enterAction.appendText);

			let typeText = '\n' + increasedIndent + '\n' + normalIndent;

			if (keepPosition) {
				ctx.executeCommand = new ReplaceCommandWithoutChangingPosition(range, typeText);
			} else {
				ctx.executeCommand = new ReplaceCommandWithOffsetCursorState(range, typeText, -1, increasedIndent.length - normalIndent.length);
			}
		} else if (enterAction.indentAction === IndentAction.Outdent) {
			let desiredIndentCount = ShiftCommand.unshiftIndentCount(indentation, indentation.length + 1, cursor.configuration.getIndentationOptions().tabSize);
			let actualIndentation = '';
			for (let i = 0; i < desiredIndentCount; i++) {
				actualIndentation += '\t';
			}
			this.actualType(cursor, '\n' + cursor.configuration.normalizeIndentation(actualIndentation + enterAction.appendText), keepPosition, ctx, range);
		}

		return true;
	}

	private static _typeInterceptorAutoClosingCloseChar(cursor:OneCursor, ch: string, ctx: IOneCursorOperationContext): boolean {
		if (!cursor.configuration.editor.autoClosingBrackets) {
			return false;
		}

		var selection = cursor.getSelection();

		if (!selection.isEmpty() || !cursor.modeConfiguration.autoClosingPairsClose.hasOwnProperty(ch)) {
			return false;
		}

		let position = cursor.getPosition();

		var lineText = cursor.model.getLineContent(position.lineNumber);
		var beforeCharacter = lineText[position.column - 1];

		if (beforeCharacter !== ch) {
			return false;
		}

		var typeSelection = new Range(position.lineNumber, position.column, position.lineNumber, position.column + 1);
		ctx.executeCommand = new ReplaceCommand(typeSelection, ch);
		return true;
	}

	private static _typeInterceptorAutoClosingOpenChar(cursor:OneCursor, ch: string, ctx: IOneCursorOperationContext): boolean {
		if (!cursor.configuration.editor.autoClosingBrackets) {
			return false;
		}

		var selection = cursor.getSelection();

		if (!selection.isEmpty() || !cursor.modeConfiguration.autoClosingPairsOpen.hasOwnProperty(ch)) {
			return false;
		}

		let richEditSupport = cursor.model.getMode().richEditSupport;

		if(!richEditSupport || !richEditSupport.characterPair) {
			return false;
		}

		let position = cursor.getPosition();
		var lineText = cursor.model.getLineContent(position.lineNumber);
		var beforeCharacter = lineText[position.column - 1];

		// Only consider auto closing the pair if a space follows or if another autoclosed pair follows
		if (beforeCharacter) {
			var isBeforeCloseBrace = false;
			for (var closeBrace in cursor.modeConfiguration.autoClosingPairsClose) {
				if (beforeCharacter === closeBrace) {
					isBeforeCloseBrace = true;
					break;
				}
			}
			if ( !isBeforeCloseBrace && !/\s/.test(beforeCharacter)) {
				return false;
			}
		}

		var lineContext = cursor.model.getLineContext(position.lineNumber);

		var shouldAutoClosePair = false;
		try {
			shouldAutoClosePair = richEditSupport.characterPair.shouldAutoClosePair(ch, lineContext, position.column - 1);
		} catch(e) {
			onUnexpectedError(e);
		}

		if (!shouldAutoClosePair) {
			return false;
		}

		ctx.shouldPushStackElementBefore = true;
		var closeCharacter = cursor.modeConfiguration.autoClosingPairsOpen[ch];
		ctx.executeCommand = new ReplaceCommandWithOffsetCursorState(selection, ch + closeCharacter, 0, -closeCharacter.length);
		return true;
	}

	private static _typeInterceptorSurroundSelection(cursor:OneCursor, ch: string, ctx: IOneCursorOperationContext): boolean {
		if (!cursor.configuration.editor.autoClosingBrackets) {
			return false;
		}

		var selection = cursor.getSelection();

		if (selection.isEmpty() || !cursor.modeConfiguration.surroundingPairs.hasOwnProperty(ch)) {
			return false;
		}

		var selectionContainsOnlyWhitespace = true,
			lineNumber:number,
			startIndex:number,
			endIndex:number,
			charIndex:number,
			charCode:number,
			lineText:string,
			_tab = '\t'.charCodeAt(0),
			_space = ' '.charCodeAt(0);

		for (lineNumber = selection.startLineNumber; lineNumber <= selection.endLineNumber; lineNumber++) {
			lineText = cursor.model.getLineContent(lineNumber);
			startIndex = (lineNumber === selection.startLineNumber ? selection.startColumn - 1 : 0);
			endIndex = (lineNumber === selection.endLineNumber ? selection.endColumn - 1 : lineText.length);
			for (charIndex = startIndex; charIndex < endIndex; charIndex++) {
				charCode = lineText.charCodeAt(charIndex);
				if (charCode !== _tab && charCode !== _space) {
					selectionContainsOnlyWhitespace = false;

					// Break outer loop
					lineNumber = selection.endLineNumber + 1;

					// Break inner loop
					charIndex = endIndex;
				}
			}
		}

		if (selectionContainsOnlyWhitespace) {
			return false;
		}

		var closeCharacter = cursor.modeConfiguration.surroundingPairs[ch];

		ctx.shouldPushStackElementBefore = true;
		ctx.shouldPushStackElementAfter = true;
		ctx.executeCommand = new SurroundSelectionCommand(selection, ch, closeCharacter);
		return true;
	}

	private static _typeInterceptorElectricChar(cursor:OneCursor, ch: string, ctx: IOneCursorOperationContext): boolean {
		if (!cursor.modeConfiguration.electricChars.hasOwnProperty(ch)) {
			return false;
		}

		ctx.postOperationRunnable = (postOperationCtx: IOneCursorOperationContext) => this._typeInterceptorElectricCharRunnable(cursor, postOperationCtx);

		return this.actualType(cursor, ch, false, ctx);
	}

	private static _typeInterceptorElectricCharRunnable(cursor:OneCursor, ctx: IOneCursorOperationContext): void {

		let position = cursor.getPosition();
		var lineText = cursor.model.getLineContent(position.lineNumber);
		var lineContext = cursor.model.getLineContext(position.lineNumber);

		var electricAction:IElectricAction;
		let richEditSupport = cursor.model.getMode().richEditSupport;
		if(richEditSupport && richEditSupport.electricCharacter) {
			try {
				electricAction = richEditSupport.electricCharacter.onElectricCharacter(lineContext, position.column - 2);
			} catch(e) {
				onUnexpectedError(e);
			}
		}

		if (electricAction) {
			let matchOpenBracket = electricAction.matchOpenBracket;
			var appendText = electricAction.appendText;
			if (matchOpenBracket) {
				var match = cursor.model.findMatchingBracketUp(matchOpenBracket, {
					lineNumber: position.lineNumber,
					column: position.column - matchOpenBracket.length
				});
				if (match) {
					var matchLineNumber = match.startLineNumber;
					var matchLine = cursor.model.getLineContent(matchLineNumber);
					var matchLineIndentation = strings.getLeadingWhitespace(matchLine);
					var newIndentation = cursor.configuration.normalizeIndentation(matchLineIndentation);

					var lineFirstNonBlankColumn = cursor.model.getLineFirstNonWhitespaceColumn(position.lineNumber) || position.column;
					var oldIndentation = lineText.substring(0, lineFirstNonBlankColumn - 1);

					if (oldIndentation !== newIndentation) {
						var prefix = lineText.substring(lineFirstNonBlankColumn - 1, position.column - 1);
						var typeText = newIndentation + prefix;

						var typeSelection = new Range(position.lineNumber, 1, position.lineNumber, position.column);
						ctx.shouldPushStackElementAfter = true;
						ctx.executeCommand = new ReplaceCommand(typeSelection, typeText);
					}
				}
			} else if (appendText) {
				var columnDeltaOffset = -appendText.length;
				if (electricAction.advanceCount) {
					columnDeltaOffset += electricAction.advanceCount;
				}
				ctx.shouldPushStackElementAfter = true;
				ctx.executeCommand = new ReplaceCommandWithOffsetCursorState(cursor.getSelection(), appendText, 0, columnDeltaOffset);
			}
		}
	}

	public static actualType(cursor:OneCursor, text: string, keepPosition: boolean, ctx: IOneCursorOperationContext, range?: editorCommon.IEditorRange): boolean {
		if (typeof range === 'undefined') {
			range = cursor.getSelection();
		}
		if (keepPosition) {
			ctx.executeCommand = new ReplaceCommandWithoutChangingPosition(range, text);
		} else {
			ctx.executeCommand = new ReplaceCommand(range, text);
		}
		return true;
	}

	public static type(cursor:OneCursor, ch: string, ctx: IOneCursorOperationContext): boolean {

		if (this._typeInterceptorEnter(cursor, ch, ctx)) {
			return true;
		}

		if (this._typeInterceptorAutoClosingCloseChar(cursor, ch, ctx)) {
			return true;
		}

		if (this._typeInterceptorAutoClosingOpenChar(cursor, ch, ctx)) {
			return true;
		}

		if (this._typeInterceptorSurroundSelection(cursor, ch, ctx)) {
			return true;
		}

		if (this._typeInterceptorElectricChar(cursor, ch, ctx)) {
			return true;
		}

		return this.actualType(cursor, ch, false, ctx);
	}

	public static replacePreviousChar(cursor:OneCursor, txt: string, replaceCharCnt:number, ctx: IOneCursorOperationContext): boolean {
		let pos = cursor.getPosition();
		let range: editorCommon.IEditorRange;
		let startColumn = Math.max(1, pos.column - replaceCharCnt);
		range = new Range(pos.lineNumber, startColumn, pos.lineNumber, pos.column);
		ctx.executeCommand = new ReplaceCommand(range, txt);
		return true;
	}

	private static _goodIndentForLine(cursor:OneCursor, lineNumber:number): string {
		var lastLineNumber = lineNumber - 1;

		for (lastLineNumber = lineNumber - 1; lastLineNumber >= 1; lastLineNumber--) {
			var lineText = cursor.model.getLineContent(lastLineNumber);
			var nonWhitespaceIdx = strings.lastNonWhitespaceIndex(lineText);
			if (nonWhitespaceIdx >= 0) {
				break;
			}
		}

		if (lastLineNumber < 1) {
			// No previous line with content found
			return '\t';
		}

		var r = getEnterActionAtPosition(cursor.model, lastLineNumber, cursor.model.getLineMaxColumn(lastLineNumber));

		var indentation: string;
		if (r.enterAction.indentAction === IndentAction.Outdent) {
			let desiredIndentCount = ShiftCommand.unshiftIndentCount(r.indentation, r.indentation.length, cursor.configuration.getIndentationOptions().tabSize);
			indentation = '';
			for (let i = 0; i < desiredIndentCount; i++) {
				indentation += '\t';
			}
			indentation = cursor.configuration.normalizeIndentation(indentation);
		} else {
			indentation = r.indentation;
		}

		var result = indentation + r.enterAction.appendText;
		if (result.length === 0) {
			// good position is at column 1, but we gotta do something...
			return '\t';
		}
		return result;
	}

	public static tab(cursor:OneCursor, ctx: IOneCursorOperationContext): boolean {
		let selection = cursor.getSelection();

		if (selection.isEmpty()) {

			let typeText = '';

			if (cursor.model.getLineMaxColumn(selection.startLineNumber) === 1) {
				// Line is empty => indent straight to the right place
				typeText = cursor.configuration.normalizeIndentation(this._goodIndentForLine(cursor, selection.startLineNumber));
			} else {
				let position = cursor.getPosition();
				if (cursor.configuration.getIndentationOptions().insertSpaces) {
					let visibleColumnFromColumn = cursor.getVisibleColumnFromColumn(position.lineNumber, position.column);
					let tabSize = cursor.configuration.getIndentationOptions().tabSize;
					let spacesCnt = tabSize - (visibleColumnFromColumn % tabSize);
					for (let i = 0; i < spacesCnt; i++) {
						typeText += ' ';
					}
				} else {
					typeText = '\t';
				}
			}

			ctx.executeCommand = new ReplaceCommand(selection, typeText);
			return true;
		} else {
			return this.indent(cursor, ctx);
		}
	}

	public static indent(cursor:OneCursor, ctx: IOneCursorOperationContext): boolean {
		var selection = cursor.getSelection();

		ctx.shouldPushStackElementBefore = true;
		ctx.shouldPushStackElementAfter = true;
		ctx.executeCommand = new ShiftCommand(selection, {
			isUnshift: false,
			tabSize: cursor.configuration.getIndentationOptions().tabSize,
			oneIndent: cursor.configuration.getOneIndent()
		});
		ctx.shouldRevealHorizontal = false;

		return true;
	}

	public static outdent(cursor:OneCursor, ctx: IOneCursorOperationContext): boolean {
		var selection = cursor.getSelection();

		ctx.shouldPushStackElementBefore = true;
		ctx.shouldPushStackElementAfter = true;
		ctx.executeCommand = new ShiftCommand(selection, {
			isUnshift: true,
			tabSize: cursor.configuration.getIndentationOptions().tabSize,
			oneIndent: cursor.configuration.getOneIndent()
		});
		ctx.shouldRevealHorizontal = false;

		return true;
	}

	public static paste(cursor:OneCursor, text: string, pasteOnNewLine: boolean, ctx: IOneCursorOperationContext): boolean {
		let position = cursor.getPosition();

		ctx.cursorPositionChangeReason = 'paste';
		if (pasteOnNewLine && text.charAt(text.length - 1) === '\n') {
			if (text.indexOf('\n') === text.length - 1) {
				// Paste entire line at the beginning of line

				var typeSelection = new Range(position.lineNumber, 1, position.lineNumber, 1);
				ctx.executeCommand = new ReplaceCommand(typeSelection, text);
				return true;
			}
		}
		ctx.executeCommand = new ReplaceCommand(cursor.getSelection(), text);
		return true;
	}

	// -------------------- END type interceptors & co.

	// -------------------- START delete handlers & co.

	private static _autoClosingPairDelete(cursor:OneCursor, ctx: IOneCursorOperationContext): boolean {
		// Returns true if delete was handled.

		if (!cursor.configuration.editor.autoClosingBrackets) {
			return false;
		}

		if (!cursor.getSelection().isEmpty()) {
			return false;
		}

		let position = cursor.getPosition();

		var lineText = cursor.model.getLineContent(position.lineNumber);
		var character = lineText[position.column - 2];

		if (!cursor.modeConfiguration.autoClosingPairsOpen.hasOwnProperty(character)) {
			return false;
		}

		var afterCharacter = lineText[position.column - 1];
		var closeCharacter = cursor.modeConfiguration.autoClosingPairsOpen[character];

		if (afterCharacter !== closeCharacter) {
			return false;
		}

		var deleteSelection = new Range(
			position.lineNumber,
			position.column - 1,
			position.lineNumber,
			position.column + 1
		);
		ctx.executeCommand = new ReplaceCommand(deleteSelection, '');

		return true;
	}

	public static deleteLeft(cursor:OneCursor, ctx: IOneCursorOperationContext): boolean {
		if (this._autoClosingPairDelete(cursor, ctx)) {
			// This was a case for an auto-closing pair delete
			return true;
		}

		var deleteSelection: editorCommon.IEditorRange = cursor.getSelection();

		if (deleteSelection.isEmpty()) {
			var position = cursor.getPosition();
			var leftOfPosition = cursor.getLeftOfPosition(position.lineNumber, position.column);
			deleteSelection = new Range(
				leftOfPosition.lineNumber,
				leftOfPosition.column,
				position.lineNumber,
				position.column
			);
		}

		if (deleteSelection.isEmpty()) {
			// Probably at beginning of file => ignore
			return true;
		}

		if (deleteSelection.startLineNumber !== deleteSelection.endLineNumber) {
			ctx.shouldPushStackElementBefore = true;
		}

		ctx.executeCommand = new ReplaceCommand(deleteSelection, '');
		return true;
	}

	private static _findLastNonWhitespaceChar(str:string, startIndex:number): number {
		for (let chIndex = startIndex; chIndex >= 0; chIndex--) {
			let ch = str.charAt(chIndex);
			if (ch !== ' ' && ch !== '\t') {
				return chIndex;
			}
		}
		return -1;
	}

	private static deleteWordLeftWhitespace(cursor:OneCursor, ctx: IOneCursorOperationContext): boolean {
		let position = cursor.getPosition();
		let lineContent = cursor.getLineContent(position.lineNumber);
		let startIndex = position.column - 2;
		let lastNonWhitespace = this._findLastNonWhitespaceChar(lineContent, startIndex);
		if (lastNonWhitespace + 1 < startIndex) {
			// bingo
			ctx.executeCommand = new ReplaceCommand(new Range(position.lineNumber, lastNonWhitespace + 2, position.lineNumber, position.column), '');
			return true;
		}
		return false;
	}

	public static deleteWordLeft(cursor:OneCursor, ctx: IOneCursorOperationContext): boolean {
		if (this._autoClosingPairDelete(cursor, ctx)) {
			// This was a case for an auto-closing pair delete
			return true;
		}

		let selection = cursor.getSelection();

		if (selection.isEmpty()) {
			let position = cursor.getPosition();

			let lineNumber = position.lineNumber;
			let column = position.column;

			if (lineNumber === 1 && column === 1) {
				// Ignore deleting at beginning of file
				return true;
			}

			if (this.deleteWordLeftWhitespace(cursor, ctx)) {
				return true;
			}

			let prevWordOnLine = cursor.findPreviousWordOnLine(position);

			if (prevWordOnLine) {
				column = prevWordOnLine.start + 1;
			} else {
				column = 1;
			}

			let deleteSelection = new Range(lineNumber, column, lineNumber, position.column);
			if (!deleteSelection.isEmpty()) {
				ctx.executeCommand = new ReplaceCommand(deleteSelection, '');
				return true;
			}
		}

		return this.deleteLeft(cursor, ctx);
	}

	public static deleteRight(cursor:OneCursor, ctx: IOneCursorOperationContext): boolean {

		var deleteSelection: editorCommon.IEditorRange = cursor.getSelection();

		if (deleteSelection.isEmpty()) {
			let position = cursor.getPosition();
			var rightOfPosition = cursor.getRightOfPosition(position.lineNumber, position.column);
			deleteSelection = new Range(
				rightOfPosition.lineNumber,
				rightOfPosition.column,
				position.lineNumber,
				position.column
			);
		}

		if (deleteSelection.isEmpty()) {
			// Probably at end of file => ignore
			return true;
		}

		if (deleteSelection.startLineNumber !== deleteSelection.endLineNumber) {
			ctx.shouldPushStackElementBefore = true;
		}

		ctx.executeCommand = new ReplaceCommand(deleteSelection, '');
		return true;
	}

	private static _findFirstNonWhitespaceChar(str:string, startIndex:number): number {
		let len = str.length;
		for (let chIndex = startIndex; chIndex < len; chIndex++) {
			let ch = str.charAt(chIndex);
			if (ch !== ' ' && ch !== '\t') {
				return chIndex;
			}
		}
		return len;
	}

	private static deleteWordRightWhitespace(cursor:OneCursor, ctx: IOneCursorOperationContext): boolean {
		let position = cursor.getPosition();
		let lineContent = cursor.getLineContent(position.lineNumber);
		let startIndex = position.column - 1;
		let firstNonWhitespace = this._findFirstNonWhitespaceChar(lineContent, startIndex);
		if (startIndex + 1 < firstNonWhitespace) {
			// bingo
			ctx.executeCommand = new ReplaceCommand(new Range(position.lineNumber, position.column, position.lineNumber, firstNonWhitespace + 1), '');
			return true;
		}
		return false;
	}

	public static deleteWordRight(cursor:OneCursor, ctx: IOneCursorOperationContext): boolean {

		var selection = cursor.getSelection();

		if (selection.isEmpty()) {
			let position = cursor.getPosition();

			var lineNumber = position.lineNumber;
			var column = position.column;

			var lineCount = cursor.model.getLineCount();
			var maxColumn = cursor.model.getLineMaxColumn(lineNumber);
			if (lineNumber === lineCount && column === maxColumn) {
				// Ignore deleting at end of file
				return true;
			}

			if (this.deleteWordRightWhitespace(cursor, ctx)) {
				return true;
			}

			let nextWordOnLine = cursor.findNextWordOnLine(position);

			if (nextWordOnLine) {
				column = nextWordOnLine.end + 1;
			} else {
				column = 1;
			}

			var deleteSelection = new Range(lineNumber, column, lineNumber, position.column);
			if (!deleteSelection.isEmpty()) {
				ctx.executeCommand = new ReplaceCommand(deleteSelection, '');
				return true;
			}
		}
		// fall back to normal deleteRight behavior
		return this.deleteRight(cursor, ctx);
	}

	public static deleteAllLeft(cursor:OneCursor, ctx: IOneCursorOperationContext): boolean {
		if (this._autoClosingPairDelete(cursor, ctx)) {
			// This was a case for an auto-closing pair delete
			return true;
		}

		var selection = cursor.getSelection();

		if (selection.isEmpty()) {
			let position = cursor.getPosition();
			var lineNumber = position.lineNumber;
			var column = position.column;

			if (column === 1) {
				// Ignore deleting at beginning of line
				return true;
			}

			var deleteSelection = new Range(lineNumber, 1, lineNumber, column);
			if (!deleteSelection.isEmpty()) {
				ctx.executeCommand = new ReplaceCommand(deleteSelection, '');
				return true;
			}
		}

		return this.deleteLeft(cursor, ctx);
	}

	public static deleteAllRight(cursor:OneCursor, ctx: IOneCursorOperationContext): boolean {
		var selection = cursor.getSelection();

		if (selection.isEmpty()) {
			let position = cursor.getPosition();
			var lineNumber = position.lineNumber;
			var column = position.column;
			var maxColumn = cursor.model.getLineMaxColumn(lineNumber);

			if (column === maxColumn) {
				// Ignore deleting at end of file
				return true;
			}

			var deleteSelection = new Range(lineNumber, column, lineNumber, maxColumn);
			if (!deleteSelection.isEmpty()) {
				ctx.executeCommand = new ReplaceCommand(deleteSelection, '');
				return true;
			}
		}

		return this.deleteRight(cursor, ctx);
	}

	public static cut(cursor:OneCursor, enableEmptySelectionClipboard:boolean, ctx: IOneCursorOperationContext): boolean {
		var selection = cursor.getSelection();

		if (selection.isEmpty()) {
			if (enableEmptySelectionClipboard) {
				// This is a full line cut

				let position = cursor.getPosition();

				var startLineNumber:number,
					startColumn:number,
					endLineNumber:number,
					endColumn:number;

				if (position.lineNumber < cursor.model.getLineCount()) {
					// Cutting a line in the middle of the model
					startLineNumber = position.lineNumber;
					startColumn = 1;
					endLineNumber = position.lineNumber + 1;
					endColumn = 1;
				} else if (position.lineNumber > 1) {
					// Cutting the last line & there are more than 1 lines in the model
					startLineNumber = position.lineNumber - 1;
					startColumn = cursor.model.getLineMaxColumn(position.lineNumber - 1);
					endLineNumber = position.lineNumber;
					endColumn = cursor.model.getLineMaxColumn(position.lineNumber);
				} else {
					// Cutting the single line that the model contains
					startLineNumber = position.lineNumber;
					startColumn = 1;
					endLineNumber = position.lineNumber;
					endColumn = cursor.model.getLineMaxColumn(position.lineNumber);
				}

				var deleteSelection = new Range(
					startLineNumber,
					startColumn,
					endLineNumber,
					endColumn
				);

				if (!deleteSelection.isEmpty()) {
					ctx.executeCommand = new ReplaceCommand(deleteSelection, '');
				}
			} else {
				// Cannot cut empty selection
				return false;
			}
		} else {
			// Delete left or right, they will both result in the selection being deleted
			this.deleteRight(cursor, ctx);
		}
		return true;
	}

	// -------------------- END delete handlers & co.
}

class CursorHelper {
	private model:editorCommon.IModel;
	private configuration:editorCommon.IConfiguration;
	private moveHelper:CursorMoveHelper;

	constructor (model:editorCommon.IModel, configuration:editorCommon.IConfiguration) {
		this.model = model;
		this.configuration = configuration;
		this.moveHelper = new CursorMoveHelper(this.configuration);
	}

	public getLeftOfPosition(model:ICursorMoveHelperModel, lineNumber:number, column:number): editorCommon.IPosition {
		return this.moveHelper.getLeftOfPosition(model, lineNumber, column);
	}

	public getRightOfPosition(model:ICursorMoveHelperModel, lineNumber:number, column:number): editorCommon.IPosition {
		return this.moveHelper.getRightOfPosition(model, lineNumber, column);
	}

	public getPositionUp(model:ICursorMoveHelperModel, lineNumber:number, column:number, leftoverVisibleColumns:number, count:number, allowMoveOnFirstLine:boolean): IMoveResult {
		return this.moveHelper.getPositionUp(model, lineNumber, column, leftoverVisibleColumns, count, allowMoveOnFirstLine);
	}

	public getPositionDown(model:ICursorMoveHelperModel, lineNumber:number, column:number, leftoverVisibleColumns:number, count:number, allowMoveOnLastLine:boolean): IMoveResult {
		return this.moveHelper.getPositionDown(model, lineNumber, column, leftoverVisibleColumns, count, allowMoveOnLastLine);
	}

	public getColumnAtBeginningOfLine(model:ICursorMoveHelperModel, lineNumber:number, column:number): number {
		return this.moveHelper.getColumnAtBeginningOfLine(model, lineNumber, column);
	}

	public getColumnAtEndOfLine(model:ICursorMoveHelperModel, lineNumber:number, column:number): number {
		return this.moveHelper.getColumnAtEndOfLine(model, lineNumber, column);
	}

	public visibleColumnFromColumn(model:ICursorMoveHelperModel, lineNumber:number, column:number): number {
		return this.moveHelper.visibleColumnFromColumn(model, lineNumber, column);
	}

	// /**
	//  * ATTENTION: This works with 0-based columns (as oposed to the regular 1-based columns)
	//  */
	// public nextTabColumn(column:number): number {
	// 	return CursorMoveHelper.nextTabColumn(column, this.configuration.getIndentationOptions().tabSize);
	// }

	// /**
	//  * ATTENTION: This works with 0-based columns (as oposed to the regular 1-based columns)
	//  */
	// public prevTabColumn(column:number): number {
	// 	return CursorMoveHelper.prevTabColumn(column, this.configuration.getIndentationOptions().tabSize);
	// }

	// public findWord(position:editorCommon.IEditorPosition, preference:string, skipSyntaxTokens:boolean=false): editorCommon.IWordRange {
	// 	var words = this.model.getWords(position.lineNumber);
	// 	var searchIndex:number, i:number, len:number;

	// 	if (skipSyntaxTokens) {
	// 		searchIndex = position.column - 1;
	// 		if (preference === 'left') {
	// 			for (i = words.length - 1; i >= 0; i--) {
	// 				if (words[i].start >= searchIndex) {
	// 					continue;
	// 				}
	// 				return words[i];
	// 			}
	// 		} else {
	// 			for (i = 0, len = words.length; i < len; i++) {
	// 				if (words[i].end <= searchIndex) {
	// 					continue;
	// 				}
	// 				return words[i];
	// 			}
	// 		}
	// 	} else {
	// 		searchIndex = position.column;
	// 		if (preference === 'left') {
	// 			if (searchIndex !== 1) {
	// 				searchIndex = searchIndex - 0.1;
	// 			}
	// 		} else {
	// 			if (searchIndex !== this.model.getLineMaxColumn(position.lineNumber)) {
	// 				searchIndex = searchIndex + 0.1;
	// 			}
	// 		}
	// 		searchIndex = searchIndex - 1;

	// 		for (i = 0, len = words.length; i < len; i++) {
	// 			if (words[i].start <= searchIndex && searchIndex <= words[i].end) {
	// 				return words[i];
	// 			}
	// 		}
	// 	}

	// 	return null;
	// }

	private _createWord(lineContent: string, wordType:WordType, start: number, end: number): IFindWordResult {
		// console.log('WORD ==> ' + start + ' => ' + end + ':::: <<<' + lineContent.substring(start, end) + '>>>');
		return { start: start, end: end, wordType: wordType };
	}

	public findPreviousWordOnLine(_position:editorCommon.IEditorPosition): IFindWordResult {
		let position = this.model.validatePosition(_position);
		let wordSeparators = getMapForWordSeparators(this.configuration.editor.wordSeparators);
		let lineContent = this.model.getLineContent(position.lineNumber);
		let wordType = W_NONE;
		for (let chIndex = position.column - 2; chIndex >= 0; chIndex--) {
			let chCode = lineContent.charCodeAt(chIndex);
			let chClass:CharacterClass = (wordSeparators[chCode] || CharacterClass.Regular);

			if (chClass === CH_REGULAR) {
				if (wordType === W_SEPARATOR) {
					return this._createWord(lineContent, wordType, chIndex + 1, this._findEndOfWord(lineContent, wordSeparators, wordType, chIndex + 1));
				}
				wordType = W_REGULAR;
			} else if (chClass === CH_WORD_SEPARATOR) {
				if (wordType === W_REGULAR) {
					return this._createWord(lineContent, wordType, chIndex + 1, this._findEndOfWord(lineContent, wordSeparators, wordType, chIndex + 1));
				}
				wordType = W_SEPARATOR;
			} else if (chClass === CH_WHITESPACE) {
				if (wordType !== W_NONE) {
					return this._createWord(lineContent, wordType, chIndex + 1, this._findEndOfWord(lineContent, wordSeparators, wordType, chIndex + 1));
				}
			}
		}

		if (wordType !== W_NONE) {
			return this._createWord(lineContent, wordType, 0, this._findEndOfWord(lineContent, wordSeparators, wordType, 0));
		}

		return null;
	}

	private _findEndOfWord(lineContent:string, wordSeparators:CharacterClass[], wordType:WordType, startIndex:number): number {
		let len = lineContent.length;
		for (let chIndex = startIndex; chIndex < len; chIndex++) {
			let chCode = lineContent.charCodeAt(chIndex);
			let chClass:CharacterClass = (wordSeparators[chCode] || CharacterClass.Regular);

			if (chClass === CH_WHITESPACE) {
				return chIndex;
			}
			if (wordType === W_REGULAR && chClass === CH_WORD_SEPARATOR) {
				return chIndex;
			}
			if (wordType === W_SEPARATOR && chClass === CH_REGULAR) {
				return chIndex;
			}
		}
		return len;
	}

	public findNextWordOnLine(_position:editorCommon.IEditorPosition): IFindWordResult {
		let position = this.model.validatePosition(_position);
		let wordSeparators = getMapForWordSeparators(this.configuration.editor.wordSeparators);
		let lineContent = this.model.getLineContent(position.lineNumber);
		let wordType = W_NONE;
		let len = lineContent.length;

		for (let chIndex = position.column - 1; chIndex < len; chIndex++) {
			let chCode = lineContent.charCodeAt(chIndex);
			let chClass:CharacterClass = (wordSeparators[chCode] || CharacterClass.Regular);

			if (chClass === CH_REGULAR) {
				if (wordType === W_SEPARATOR) {
					return this._createWord(lineContent, wordType, this._findStartOfWord(lineContent, wordSeparators, wordType, chIndex - 1), chIndex);
				}
				wordType = W_REGULAR;
			} else if (chClass === CH_WORD_SEPARATOR) {
				if (wordType === W_REGULAR) {
					return this._createWord(lineContent, wordType, this._findStartOfWord(lineContent, wordSeparators, wordType, chIndex - 1), chIndex);
				}
				wordType = W_SEPARATOR;
			} else if (chClass === CH_WHITESPACE) {
				if (wordType !== W_NONE) {
					return this._createWord(lineContent, wordType, this._findStartOfWord(lineContent, wordSeparators, wordType, chIndex - 1), chIndex);
				}
			}
		}

		if (wordType !== W_NONE) {
			return this._createWord(lineContent, wordType, this._findStartOfWord(lineContent, wordSeparators, wordType, len - 1), len);
		}

		return null;
	}

	private _findStartOfWord(lineContent:string, wordSeparators:CharacterClass[], wordType:WordType, startIndex:number): number {
		for (let chIndex = startIndex; chIndex >= 0; chIndex--) {
			let chCode = lineContent.charCodeAt(chIndex);
			let chClass:CharacterClass = (wordSeparators[chCode] || CharacterClass.Regular);

			if (chClass === CH_WHITESPACE) {
				return chIndex + 1;
			}
			if (wordType === W_REGULAR && chClass === CH_WORD_SEPARATOR) {
				return chIndex + 1;
			}
			if (wordType === W_SEPARATOR && chClass === CH_REGULAR) {
				return chIndex + 1;
			}
		}
		return 0;
	}
}

function once<T, R>(keyFn:(input:T)=>string, computeFn:(input:T)=>R):(input:T)=>R {
	let cache: {[key:string]:R;} = {};
	return (input:T):R => {
		let key = keyFn(input);
		if (!cache.hasOwnProperty(key)) {
			cache[key] = computeFn(input);
		}
		return cache[key];
	};
}

var getMapForWordSeparators = once<string,CharacterClass[]>(
	(input) => input,
	(input) => {

		let r:CharacterClass[] = [];

		// Make array fast for ASCII text
		for (let chCode = 0; chCode < 256; chCode++) {
			r[chCode] = CharacterClass.Regular;
		}

		for (let i = 0, len = input.length; i < len; i++) {
			r[input.charCodeAt(i)] = CharacterClass.WordSeparator;
		}

		r[' '.charCodeAt(0)] = CharacterClass.Whitespace;
		r['\t'.charCodeAt(0)] = CharacterClass.Whitespace;

		return r;
	}
);

class Utils {

	/**
	 * Range contains position (including edges)?
	 */
	static rangeContainsPosition(range:editorCommon.IRange, position:editorCommon.IPosition): boolean {
		if (position.lineNumber < range.startLineNumber || position.lineNumber > range.endLineNumber) {
			return false;
		}
		if (position.lineNumber === range.startLineNumber && position.column < range.startColumn) {
			return false;
		}
		if (position.lineNumber === range.endLineNumber && position.column > range.endColumn) {
			return false;
		}
		return true;
	}

	/**
	 * Tests if position is contained inside range.
	 * If position is either the starting or ending of a range, false is returned.
	 */
	static isPositionInsideRange(position:editorCommon.IPosition, range:editorCommon.IRange): boolean {
		if (position.lineNumber < range.startLineNumber) {
			return false;
		}
		if (position.lineNumber > range.endLineNumber) {
			return false;
		}
		if (position.lineNumber === range.startLineNumber && position.column < range.startColumn) {
			return false;
		}
		if (position.lineNumber === range.endLineNumber && position.column > range.endColumn) {
			return false;
		}
		return true;
	}

	static isPositionAtRangeEdges(position:editorCommon.IPosition, range:editorCommon.IRange): boolean {
		if (position.lineNumber === range.startLineNumber && position.column === range.startColumn) {
			return true;
		}
		if (position.lineNumber === range.endLineNumber && position.column === range.endColumn) {
			return true;
		}
		return false;
	}
}
